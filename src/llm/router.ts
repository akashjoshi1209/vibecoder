// Model router: decides per user turn which of two endpoints handles the work.
//
//  - chat/light  (default fast/cheap model, e.g. groq/qwen) — conversation,
//    simple queries, small talk.
//  - heavy        (big reasoning/coding model, e.g. nvidia/nemotron-3-ultra) —
//    coding, debugging, build tasks, complex reasoning.
//
// Decision per turn (strategy "hybrid", default):
//   1. Keyword rules classify the message fast (chat / heavy / ambiguous).
//   2. Ambiguous messages are handed to the cheap model for a one-word
//      CHAT vs HEAVY verdict (~1-3s extra) — unless the conversation is
//      already mid-task (sticky mode), in which case we stay heavy.
// Strategy "keyword" skips the classifier call and treats ambiguous as chat.
//
// The loop itself is unchanged: this resolves ONCE per user turn, before
// runAgent, and everything inside that turn runs on the chosen model.
import { createProvider, type RootConfig } from "./client";
import type { ChatOptions, Message, StreamResult, LLMProvider } from "./types";

export type RoutingMode = "auto" | "chat" | "heavy";
export type Classification = "chat" | "heavy" | "ambiguous";

export interface RoutingConfig {
  chatProvider: string;
  chatModel: string;
  heavyProvider: string;
  heavyModel: string;
  strategy: "keyword" | "hybrid";
}

export interface RouteResult {
  provider: LLMProvider;
  providerName: string;
  model: string;
  /** Token budget to pass to the loop: set for the light model, undefined for heavy (1M ctx). */
  maxInputTokens?: number;
  maxInputTokensPerMinute?: number;
}

const CLASSIFIER_SYSTEM =
  "You classify a user message into exactly one of two intents. Reply with exactly one word: CHAT or HEAVY.\n" +
  "- CHAT: casual conversation, greetings, small talk, simple factual questions, opinions, jokes, short yes/no.\n" +
  "- HEAVY: coding, writing/fixing/debugging software, file/terminal work, building something, analyze/design/complex reasoning.\n" +
  "Never output anything other than CHAT or HEAVY.";

// --- Keyword classification -------------------------------------------------

const RE_HEAVY_FENCE = /```|`[a-z]+\s*\n/;
const RE_HEAVY_IDIOM = /#include\s*[<"]|def\s+\w+\s*\(|function\s+\w+\s*\(|=>|\bconst\s+\w+\s*=\s*[\[{(]|\bpackage\s+\w+|\bimport\s+(static\s+)?[\w.]+/;
const RE_HEAVY_FILE = /\b[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cpp|cxx|cc|c|h|hpp|cs|php|rb|sh|bash|zsh|json|ya?ml|toml|sql|css|scss|htm[l]?|md|txt|lock|env)\b/i;
const RE_HEAVY_COMMAND = /\b(fix|fixing|debug|debugging|debugger|refactor|rewrite|deploy|install|configure|compile|implement|implementing|migrate|optimize|optimise|build|develop|program|port|patch|patches)\b/i;
const RE_HEAVY_CREATE = /\b(write|create|make|add|modify|update|change|generate|clean|organize|set up|setup|help)\b.{0,60}\b(code|script|function|class|app|application|api|endpoint|service|module|program|project|file|repo|repository|tool|cli|command|server|database|db|bot|website|web ?site|page|component|widget|pipeline|workflow|config|config|schema|query|algorithm|structure|functionality|tests?)\b/i;
const RE_HEAVY_BUG = /\b(error|bug|exception|traceback|crash(es|ed|ing)?|fail|failed|failing|fails|null pointer|null reference|segfault|panic|undefined is not|syntax error|not working|doesn'?t work|does not work|won'?t run|won'?t compile|broken|deprecated)\b/i;
const RE_HEAVY_ANALYSIS = /\b(analy[sz]e|analy[sz]is|architect|architecture|algorithm|algorithms|complexity|concurrency|deadlock|race condition|big.?o)\b/i;
const RE_HEAVY_LANG_TASK = /\b(python|javascript|typescript|node(js)?|react|vue|svelte|rust|golang|go|c\+\+|java|php|ruby|docker|kubernetes|terraform|graphql|sql)\b.{0,80}\b(code|script|function|app|api|program|file|repo|fix|write|build|debug|implement|migrate|deploy|how do i|create|install|run)\b/i;
const RE_HEAVY_RUN = /^\s*[a-z0-9_-]+\s+(\-\S+\s+)*.*(--help|--version|-h\b)/i;

const RE_CHAT_GREETING = /^\s*(hi+|hey+|hello|yo|sup|wassup|howdy|hiya|good\s+(morning|afternoon|evening)|good day|hello there|hey there|hi there|howdy there)[!.,…]*\s*$/;
const RE_CHAT_SOCIAL = /\b(how are you|how'?s it going|what'?s up|are you there|you still there|how'?s your day)\b/;
const RE_CHAT_ACK = /^\s*(ok|okay|\bk+(ay)?\b|great|awesome|cool|perfect|nice|thanks|thank you|ty|thx|lol|haha|hehe|yes|yep|yeah|yup|sure|nope|no|good|fine|sounds good|got it|i see|understood|done|bye|goodbye|good night|see you|good morning|good afternoon|good evening)[\s!.,…]*$/;
const RE_CHAT_META = /\b(who are you|what are you|what model|what models|models\s+(do |would )?(you|u)\s+(have|got|support|run)|tell\s+me\s+.*models|l[ie]st\s*.*models|what can you do|what tools can you|how do you work)\b/;
const RE_CHAT_FACTUAL = /\b(what is|what'?s|who is|who'?s|when was|when is|where is|tell me about|define|meaning of|difference between|explain (the|it|this|why|how))\b/;

const HEAVY_RULES: RegExp[] = [
  RE_HEAVY_FENCE,
  RE_HEAVY_IDIOM,
  RE_HEAVY_FILE,
  RE_HEAVY_COMMAND,
  RE_HEAVY_CREATE,
  RE_HEAVY_BUG,
  RE_HEAVY_ANALYSIS,
  RE_HEAVY_LANG_TASK,
  RE_HEAVY_RUN,
];

const CHAT_RULES: RegExp[] = [RE_CHAT_GREETING, RE_CHAT_SOCIAL, RE_CHAT_ACK, RE_CHAT_META, RE_CHAT_FACTUAL];

/**
 * Pure keyword classifier. Heavy signals win over chat signals; everything else
 * is ambiguous (handled by the cheap-model fallback when strategy is "hybrid").
 */
export function classifyMessage(text: string): Classification {
  const t = (text ?? "").trim();
  if (!t) return "chat";
  if (HEAVY_RULES.some((re) => re.test(t))) return "heavy";
  if (CHAT_RULES.some((re) => re.test(t))) return "chat";
  if (t.length > 300) return "heavy";
  return "ambiguous";
}

// --- Router -----------------------------------------------------------------

export class ModelRouter {
  private chat: { provider: LLMProvider; providerName: string; model: string };
  private heavy: { provider: LLMProvider; providerName: string; model: string };
  private readonly strategy: "keyword" | "hybrid";
  private readonly chatMaxInputTokens?: number;
  private readonly chatMaxInputTokensPerMinute?: number;
  private classifierOverride?: (text: string) => Promise<"chat" | "heavy">;

  constructor(
    private config: RootConfig,
    opts: {
      maxInputTokens?: number;
      maxInputTokensPerMinute?: number;
      /** Injectable one-word classifier for tests; defaults to a real cheap-model call. */
      classifier?: (text: string) => Promise<"chat" | "heavy">;
    } = {},
  ) {
    this.chatMaxInputTokens = opts.maxInputTokens;
    this.chatMaxInputTokensPerMinute = opts.maxInputTokensPerMinute;
    this.classifierOverride = opts.classifier;

    const routing = config.routing;
    const strategy = routing?.strategy ?? "hybrid";
    this.strategy = strategy === "keyword" ? "keyword" : "hybrid";

    const topName = config.provider;
    const topModel = config.model;
    const chatName = routing?.chatProvider ?? topName;
    const chatModel = routing?.chatModel ?? (chatName === topName ? topModel : config.providers[chatName]?.models[0] ?? topModel);
    const heavyName = routing?.heavyProvider ?? topName;
    const heavyModel = routing?.heavyModel ?? (heavyName === topName ? topModel : config.providers[heavyName]?.models[0] ?? topModel);

    this.chat = this.buildSide(chatName, chatModel);
    // If the heavy side cannot be built (e.g. provider removed), fall back to
    // the chat side so the router degrades to a single-model passthrough.
    const safeHeavy = (() => {
      try {
        const side = this.buildSide(heavyName, heavyModel);
        return side;
      } catch {
        return { ...this.chat };
      }
    })();
    this.heavy = safeHeavy;
  }

  private buildSide(name: string, model: string): { provider: LLMProvider; providerName: string; model: string } {
    const r = createProvider(this.config, name);
    const validModels = this.config.providers[name]?.models ?? [r.model];
    const chosen = validModels.includes(model) ? model : r.model;
    return { provider: r.provider, providerName: r.name, model: chosen };
  }

  /** Rebuild the chat (light) side after a provider switch. */
  setChat(name: string, model?: string): boolean {
    try {
      this.chat = this.buildSide(name, model ?? this.chat.model);
      return true;
    } catch {
      return false;
    }
  }

  /** Rebuild the heavy side after a provider switch. */
  setHeavy(name: string, model?: string): boolean {
    try {
      this.heavy = this.buildSide(name, model ?? this.heavy.model);
      return true;
    } catch {
      return false;
    }
  }

  /** Override the fallback classifier at runtime (tests, debugging). */
  setClassifier(fn: (text: string) => Promise<"chat" | "heavy">): void {
    this.classifierOverride = fn;
  }

  names(): { chat: string; heavy: string } {
    return { chat: this.chat.providerName, heavy: this.heavy.providerName };
  }

  chatIdentity(): { provider: string; model: string } {
    return { provider: this.chat.providerName, model: this.chat.model };
  }

  heavyIdentity(): { provider: string; model: string } {
    return { provider: this.heavy.providerName, model: this.heavy.model };
  }

  isHeavy(route: RouteResult): boolean {
    return route.providerName === this.heavy.providerName && route.model === this.heavy.model;
  }

  /** Pick the model for this turn. Never returns "ambiguous" — it resolves on the
   *  cheap side or via the classifier. */
  async resolve(userMessage: string, mode: RoutingMode, taskActive = false): Promise<RouteResult> {
    if (mode === "chat") return this.route("chat", userMessage);
    if (mode === "heavy") return this.route("heavy", userMessage);

    const c = classifyMessage(userMessage);
    if (c === "heavy") return this.route("heavy", userMessage);
    if (c === "chat") return this.route("chat", userMessage);

    // Ambiguous: stay heavy when mid-task, otherwise ask the cheap model.
    if (taskActive) return this.route("heavy", userMessage);
    if (this.strategy === "hybrid") {
      const verdict = await this.classifyWithQwen(userMessage);
      return this.route(verdict, userMessage);
    }
    return this.route("chat", userMessage);
  }

  private route(kind: "chat" | "heavy", _userMessage: string): RouteResult {
    const side = kind === "chat" ? this.chat : this.heavy;
    const heavy = kind === "heavy";
    return {
      provider: side.provider,
      providerName: side.providerName,
      model: side.model,
      maxInputTokens: heavy ? undefined : this.chatMaxInputTokens,
      maxInputTokensPerMinute: heavy ? undefined : this.chatMaxInputTokensPerMinute,
    };
  }

  /** Cheap-model one-word verdict for ambiguous messages. Defaults to "chat"
   *  on any failure so the conversation never blocks on the classifier. */
  private async classifyWithQwen(text: string): Promise<"chat" | "heavy"> {
    if (this.classifierOverride) {
      try {
        return await this.classifierOverride(text);
      } catch {
        return "chat";
      }
    }
    const messages: Message[] = [
      { role: "system", content: CLASSIFIER_SYSTEM },
      { role: "user", content: text },
    ];
    const opts: ChatOptions = { model: this.chat.model, messages, max_tokens: 4, temperature: 0, timeoutMs: 10_000, timeoutIdleMs: 8_000 };
    try {
      const res: StreamResult = await this.chat.provider.streamChat(opts, () => {});
      const word = (res.text ?? "").trim().toLowerCase();
      if (word.includes("heavy")) return "heavy";
      if (word.includes("chat")) return "chat";
    } catch {
      /* fall through to "chat" */
    }
    return "chat";
  }
}