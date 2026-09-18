#!/usr/bin/env node
// src/llm/types.ts
class ContextTooLargeError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.name = "ContextTooLargeError";
    this.status = status;
  }
}

// src/llm/timeout.ts
class LLMTimeoutError extends Error {
  kind;
  elapsedMs;
  constructor(kind, elapsedMs) {
    super(kind === "idle" ? `LLM stream stalled: no data for ${Math.round(elapsedMs / 1000)}s. Check your network connection (set timeoutIdleMs in config.json to tune).` : `LLM request timed out after ${Math.round(elapsedMs / 1000)}s. Check your network connection (set timeoutMs in config.json to tune).`);
    this.kind = kind;
    this.elapsedMs = elapsedMs;
    this.name = "LLMTimeoutError";
  }
}
function withTimeout(opts, start) {
  const total = opts.timeoutMs ?? 120000;
  const idle = opts.idleMs ?? 60000;
  const ac = new AbortController;
  const userSignal = opts.signal;
  const onUserAbort = () => ac.abort(userSignal?.reason);
  if (userSignal?.aborted)
    queueMicrotask(() => ac.abort(userSignal.reason));
  userSignal?.addEventListener("abort", onUserAbort, { once: true });
  let lastDataAt = Date.now();
  let fired = null;
  const fire = (kind) => {
    if (fired || ac.signal.aborted)
      return;
    const e = new LLMTimeoutError(kind, kind === "idle" ? Date.now() - lastDataAt : total);
    fired = e;
    opts.onTimeout?.(e);
    ac.abort(e);
  };
  const totalTimer = setTimeout(() => fire("total"), total);
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataAt > idle)
      fire("idle");
  }, 250);
  const markData = () => {
    lastDataAt = Date.now();
  };
  return start(ac.signal, markData).finally(() => {
    clearTimeout(totalTimer);
    clearInterval(watchdog);
    userSignal?.removeEventListener("abort", onUserAbort);
  });
}

// src/llm/retry.ts
function parseRetryAfter(res, bodyText, fallbackMs = 5000) {
  const header = res.headers.get("retry-after");
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n))
      return clampMs(n * 1000);
  }
  const match = bodyText.match(/in\s+(\d+(?:\.\d+)?)\s*s(?:econds?)?/i);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n))
      return clampMs(n * 1000);
  }
  return clampMs(fallbackMs);
}
function clampMs(ms) {
  return Math.min(60000, Math.max(1000, Math.round(ms)));
}
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
var isTransientRateLimit = (status) => status === 429 || status === 502 || status === 503 || status === 504;

// src/llm/args.ts
function parseToolArguments(raw) {
  let args = {};
  try {
    args = JSON.parse(raw || "{}");
    if (typeof args !== "object" || args === null || Array.isArray(args))
      args = {};
  } catch {
    const extracted = extractJson(raw);
    if (extracted !== null)
      args = extracted;
  }
  return args;
}
function extractJson(raw) {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first)
    return null;
  try {
    const parsed = JSON.parse(raw.slice(first, last + 1));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed;
  } catch {
    return null;
  }
  return null;
}

// src/llm/providers/anthropic.ts
function mapToAnthropic(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const result = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content ?? ""
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last._toolGroup) {
        last.content.push(result);
      } else {
        out.push({ role: "user", content: [result], _toolGroup: true });
      }
      continue;
    }
    const content = [];
    if (m.content)
      content.push({ type: "text", text: m.content });
    if (m.tool_calls && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: parseToolArguments(tc.arguments)
        });
      }
    }
    if (content.length === 0)
      content.push({ type: "text", text: "" });
    out.push({ role: m.role, content });
  }
  for (const m of out)
    delete m._toolGroup;
  return out;
}

class AnthropicProvider {
  config;
  constructor(config) {
    this.config = config;
  }
  async streamChat(options, onChunk) {
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
    if (!key)
      throw new Error(`Missing API key for Anthropic (set ${this.config.apiKeyEnv})`);
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    };
    const system = options.messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join(`
`);
    const body = {
      model: options.model,
      max_tokens: options.max_tokens ?? 4096,
      stream: true,
      messages: mapToAnthropic(options.messages.filter((m) => m.role !== "system"))
    };
    if (system)
      body.system = system;
    if (options.temperature !== undefined)
      body.temperature = options.temperature;
    if (options.tools && options.tools.length) {
      body.tools = options.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters
      }));
    }
    let timedOut = null;
    const timeoutOpts = {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      idleMs: options.timeoutIdleMs ?? this.config.timeoutIdleMs,
      onTimeout: (e) => timedOut = e
    };
    try {
      return await withTimeout(timeoutOpts, async (signal, markData) => {
        const maxAttempts = (this.config.maxRateLimitRetries ?? 2) + 1;
        for (let attempt = 0;attempt < maxAttempts; attempt++) {
          const res = await fetch(`${this.config.baseURL}/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal
          });
          if (isTransientRateLimit(res.status)) {
            const text = await res.text().catch(() => "");
            if (attempt === maxAttempts - 1) {
              throw new Error(`Rate limited (HTTP ${res.status}) after ${maxAttempts} attempts: ${text.slice(0, 400)}`);
            }
            await sleepAbortable(parseRetryAfter(res, text), signal);
            markData();
            continue;
          }
          if (res.status === 413 || res.status === 400) {
            const text = await res.text().catch(() => "");
            if (res.status === 413 || /(prompt_too_long|request_too_large|too_many_tokens|maximum context|too long)/i.test(text)) {
              throw new ContextTooLargeError(res.status, `Context too large (HTTP ${res.status}): ${text.slice(0, 500)}`);
            }
            throw new Error(`Anthropic request failed (${res.status}): ${text.slice(0, 500)}`);
          }
          markData();
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            throw new Error(`Anthropic request failed (${res.status}): ${text.slice(0, 500)}`);
          }
          return this.parseSSE(res.body, onChunk, markData);
        }
        throw new Error("unreachable");
      });
    } catch (err) {
      if (timedOut)
        throw timedOut;
      throw err;
    }
  }
  async parseSSE(body, onChunk, onData) {
    const reader = body.getReader();
    const decoder = new TextDecoder;
    let buffer = "";
    let text = "";
    const toolCalls = [];
    let finishReason = null;
    let currentTool = null;
    const flushTool = () => {
      if (!currentTool)
        return;
      toolCalls.push({
        id: currentTool.id,
        name: currentTool.name,
        arguments: currentTool.args || "{}"
      });
      currentTool = null;
    };
    const processLine = (line) => {
      if (!line.startsWith("data:"))
        return;
      const data = line.slice(5).trim();
      if (data === "[DONE]")
        return;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const type = json.type;
      if (type === "message_delta") {
        finishReason = json.delta?.stop_reason ?? finishReason;
      } else if (type === "content_block_start") {
        if (json.content_block?.type === "tool_use") {
          flushTool();
          currentTool = {
            id: json.content_block.id,
            name: json.content_block.name,
            startIdx: toolCalls.length,
            args: ""
          };
        }
      } else if (type === "content_block_delta") {
        const delta = json.delta;
        if (delta?.type === "text_delta") {
          text += delta.text;
          onChunk({ content: delta.text ?? "" });
        } else if (delta?.type === "input_json_delta" && currentTool) {
          currentTool.args += delta.partial_json ?? "";
        }
      } else if (type === "content_block_stop") {
        flushTool();
      } else if (type === "message_start") {}
    };
    while (true) {
      const { done, value } = await reader.read();
      onData?.();
      if (done)
        break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(`
`);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed)
          processLine(trimmed);
      }
    }
    flushTool();
    if (toolCalls.length)
      onChunk({ content: "", tool_calls: toolCalls.map((c) => ({ ...c })) });
    return { text, toolCalls, finishReason };
  }
}

// src/llm/providers/openai-compatible.ts
class OpenAICompatibleProvider {
  config;
  constructor(config) {
    this.config = config;
  }
  async streamChat(options, onChunk) {
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
    if (this.config.apiKeyEnv && !key) {
      throw new Error(`Missing ${this.config.apiKeyEnv} env var — set it to use this provider`);
    }
    const headers = {
      "Content-Type": "application/json"
    };
    if (key)
      headers["Authorization"] = `Bearer ${key}`;
    const body = {
      model: options.model,
      messages: options.messages.map((m) => {
        const msg = {
          role: m.role,
          content: m.content ?? (m.role === "assistant" ? "" : null)
        };
        if (m.tool_calls && m.tool_calls.length) {
          msg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments || "" }
          }));
        }
        if (m.tool_call_id)
          msg.tool_call_id = m.tool_call_id;
        if (m.name)
          msg.name = m.name;
        return msg;
      }),
      stream: true
    };
    if (options.temperature !== undefined)
      body.temperature = options.temperature;
    if (options.max_tokens !== undefined)
      body.max_tokens = options.max_tokens;
    if (options.tools && options.tools.length)
      body.tools = options.tools;
    let timedOut = null;
    const timeoutOpts = {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      idleMs: options.timeoutIdleMs ?? this.config.timeoutIdleMs,
      onTimeout: (e) => timedOut = e
    };
    try {
      return await withTimeout(timeoutOpts, async (signal, markData) => {
        const maxAttempts = (this.config.maxRateLimitRetries ?? 2) + 1;
        for (let attempt = 0;attempt < maxAttempts; attempt++) {
          const res = await fetch(`${this.config.baseURL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal
          });
          if (isTransientRateLimit(res.status)) {
            const text = await res.text().catch(() => "");
            if (attempt === maxAttempts - 1) {
              throw new Error(`Rate limited (HTTP ${res.status}) after ${maxAttempts} attempts: ${text.slice(0, 400)}`);
            }
            await sleepAbortable(parseRetryAfter(res, text), signal);
            markData();
            continue;
          }
          if (res.status === 413 || res.status === 400) {
            const text = await res.text().catch(() => "");
            if (res.status === 413 || /(context_length|context length|too large|prompt too long|maximum context)/i.test(text)) {
              throw new ContextTooLargeError(res.status, `Context too large (HTTP ${res.status}): ${text.slice(0, 500)}`);
            }
            throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
          }
          markData();
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
          }
          return this.parseSSE(res.body, onChunk, markData);
        }
        throw new Error("unreachable");
      });
    } catch (err) {
      if (timedOut)
        throw timedOut;
      throw err;
    }
  }
  async parseSSE(body, onChunk, onData) {
    const reader = body.getReader();
    const decoder = new TextDecoder;
    let buffer = "";
    let text = "";
    const toolCalls = [];
    let finishReason = null;
    let reasoning = "";
    const processLine = (line) => {
      if (!line.startsWith("data:"))
        return;
      const data = line.slice(5).trim();
      if (data === "[DONE]")
        return;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const delta = json.choices?.[0]?.delta;
      finishReason = json.choices?.[0]?.finish_reason ?? finishReason;
      if (!delta)
        return;
      if (delta.content) {
        text += delta.content;
        onChunk({ content: delta.content });
      }
      const reason = delta.reasoning_content ?? delta.reasoning;
      if (reason) {
        reasoning += reason;
        onChunk({ content: "", reasoning: reason });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          while (toolCalls.length <= idx)
            toolCalls.push({ id: "", name: "", arguments: "" });
          const current = toolCalls[idx];
          if (tc.id && !current.id)
            current.id = tc.id;
          if (tc.function?.name && !current.name)
            current.name = tc.function.name;
          if (tc.function?.arguments)
            current.arguments += tc.function.arguments;
        }
        onChunk({
          content: "",
          tool_calls: [...toolCalls].map((c) => ({ ...c }))
        });
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      onData?.();
      if (done)
        break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(`
`);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed)
          processLine(trimmed);
      }
    }
    const rest = buffer.trim();
    if (rest)
      processLine(rest);
    return { text, toolCalls, finishReason, reasoning: reasoning || undefined };
  }
}

// src/config.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/paths.ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
function packageRoot() {
  return dirname(fileURLToPath(import.meta.url));
}
function resolvePackageFile(...names) {
  const name = join(...names);
  const here = join(packageRoot(), name);
  if (existsSync(here))
    return here;
  const parent = join(dirname(packageRoot()), name);
  if (existsSync(parent))
    return parent;
  return null;
}
function readPackageJson() {
  const f = resolvePackageFile("package.json");
  if (f) {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {}
  }
  const v = resolvePackageFile("version.json");
  if (!v)
    return null;
  try {
    const m = JSON.parse(readFileSync(v, "utf8"));
    return { name: m.name ?? "vibecoder", version: m.version ?? undefined };
  } catch {
    return null;
  }
}

// src/config.ts
var FALLBACK_CONFIG = {
  provider: "ollama",
  model: "qwen2.5:1.5b",
  providers: {
    ollama: {
      type: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "",
      timeoutMs: 240000,
      timeoutIdleMs: 120000,
      models: ["qwen2.5:1.5b", "llama3.1"]
    }
  }
};
function userConfigFile() {
  const sessionDir = process.env.VIBECODER_SESSION_DIR;
  if (sessionDir)
    return join2(sessionDir, "config.json");
  return join2(homedir(), ".vibecoder", "config.json");
}
function configPaths() {
  const envConfig = process.env.VIBECODER_CONFIG;
  if (envConfig) {
    return { builtin: null, effectiveFile: envConfig, userFile: null, merged: false };
  }
  const builtin = resolvePackageFile("config.json");
  const userFile = userConfigFile();
  if (existsSync2(userFile)) {
    return { builtin, effectiveFile: userFile, userFile, merged: true };
  }
  return { builtin, effectiveFile: builtin ?? userFile, userFile, merged: false };
}
function isPlainObject(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function deepMerge(base, override) {
  if (override === undefined)
    return base;
  if (!isPlainObject(base) || !isPlainObject(override))
    return override;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    const v = override[key];
    if (v === undefined)
      continue;
    if (v === null) {
      delete out[key];
      continue;
    }
    out[key] = deepMerge(base[key], v);
  }
  return out;
}
function loadJsonFile(file) {
  return JSON.parse(readFileSync2(file, "utf8"));
}
async function loadConfig(path) {
  if (path)
    return loadJsonFile(path);
  if (process.env.VIBECODER_CONFIG)
    return loadJsonFile(process.env.VIBECODER_CONFIG);
  const { builtin, effectiveFile, merged } = configPaths();
  const base = builtin ? loadJsonFile(builtin) : FALLBACK_CONFIG;
  if (merged) {
    const user = loadJsonFile(effectiveFile);
    return deepMerge(base, user);
  }
  return base;
}
async function loadConfigInfo() {
  const paths = configPaths();
  const config = await loadConfig();
  return { config, paths };
}
function writeUserConfig(config) {
  const file = userConfigFile();
  mkdirSync(join2(homedir(), ".vibecoder"), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + `
`, "utf8");
  return file;
}

// src/llm/client.ts
function createProvider(config, providerName) {
  const name = providerName || config.provider;
  const pc = config.providers[name];
  if (!pc)
    throw new Error(`Unknown provider "${name}". Available: ${Object.keys(config.providers).join(", ")}`);
  let provider;
  if (pc.type === "anthropic") {
    provider = new AnthropicProvider(pc);
  } else {
    provider = new OpenAICompatibleProvider(pc);
  }
  const model = pc.models.includes(config.model) ? config.model : pc.models[0] ?? config.model;
  return { provider, model, name };
}

// src/llm/router.ts
var CLASSIFIER_SYSTEM = `You classify a user message into exactly one of two intents. Reply with exactly one word: CHAT or HEAVY.
` + `- CHAT: casual conversation, greetings, small talk, simple factual questions, opinions, jokes, short yes/no.
` + `- HEAVY: coding, writing/fixing/debugging software, file/terminal work, building something, analyze/design/complex reasoning.
` + "Never output anything other than CHAT or HEAVY.";
var RE_HEAVY_FENCE = /```|`[a-z]+\s*\n/;
var RE_HEAVY_IDIOM = /#include\s*[<"]|def\s+\w+\s*\(|function\s+\w+\s*\(|=>|\bconst\s+\w+\s*=\s*[\[{(]|\bpackage\s+\w+|\bimport\s+(static\s+)?[\w.]+/;
var RE_HEAVY_FILE = /\b[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cpp|cxx|cc|c|h|hpp|cs|php|rb|sh|bash|zsh|json|ya?ml|toml|sql|css|scss|htm[l]?|md|txt|lock|env)\b/i;
var RE_HEAVY_COMMAND = /\b(fix|fixing|debug|debugging|debugger|refactor|rewrite|deploy|install|configure|compile|implement|implementing|migrate|optimize|optimise|build|develop|program|port|patch|patches)\b/i;
var RE_HEAVY_CREATE = /\b(write|create|make|add|modify|update|change|generate|clean|organize|set up|setup|help)\b.{0,60}\b(code|script|function|class|app|application|api|endpoint|service|module|program|project|file|repo|repository|tool|cli|command|server|database|db|bot|website|web ?site|page|component|widget|pipeline|workflow|config|config|schema|query|algorithm|structure|functionality|tests?)\b/i;
var RE_HEAVY_BUG = /\b(error|bug|exception|traceback|crash(es|ed|ing)?|fail|failed|failing|fails|null pointer|null reference|segfault|panic|undefined is not|syntax error|not working|doesn'?t work|does not work|won'?t run|won'?t compile|broken|deprecated)\b/i;
var RE_HEAVY_ANALYSIS = /\b(analy[sz]e|analy[sz]is|architect|architecture|algorithm|algorithms|complexity|concurrency|deadlock|race condition|big.?o)\b/i;
var RE_HEAVY_LANG_TASK = /\b(python|javascript|typescript|node(js)?|react|vue|svelte|rust|golang|go|c\+\+|java|php|ruby|docker|kubernetes|terraform|graphql|sql)\b.{0,80}\b(code|script|function|app|api|program|file|repo|fix|write|build|debug|implement|migrate|deploy|how do i|create|install|run)\b/i;
var RE_HEAVY_RUN = /^\s*[a-z0-9_-]+\s+(\-\S+\s+)*.*(--help|--version|-h\b)/i;
var RE_CHAT_GREETING = /^\s*(hi+|hey+|hello|yo|sup|wassup|howdy|hiya|good\s+(morning|afternoon|evening)|good day|hello there|hey there|hi there|howdy there)[!.,…]*\s*$/;
var RE_CHAT_SOCIAL = /\b(how are you|how'?s it going|what'?s up|are you there|you still there|how'?s your day)\b/;
var RE_CHAT_ACK = /^\s*(ok|okay|\bk+(ay)?\b|great|awesome|cool|perfect|nice|thanks|thank you|ty|thx|lol|haha|hehe|yes|yep|yeah|yup|sure|nope|no|good|fine|sounds good|got it|i see|understood|done|bye|goodbye|good night|see you|good morning|good afternoon|good evening)[\s!.,…]*$/;
var RE_CHAT_META = /\b(who are you|what are you|what model|what models|models\s+(do |would )?(you|u)\s+(have|got|support|run)|tell\s+me\s+.*models|l[ie]st\s*.*models|what can you do|what tools can you|how do you work)\b/;
var RE_CHAT_FACTUAL = /\b(what is|what'?s|who is|who'?s|when was|when is|where is|tell me about|define|meaning of|difference between|explain (the|it|this|why|how))\b/;
var HEAVY_RULES = [
  RE_HEAVY_FENCE,
  RE_HEAVY_IDIOM,
  RE_HEAVY_FILE,
  RE_HEAVY_COMMAND,
  RE_HEAVY_CREATE,
  RE_HEAVY_BUG,
  RE_HEAVY_ANALYSIS,
  RE_HEAVY_LANG_TASK,
  RE_HEAVY_RUN
];
var CHAT_RULES = [RE_CHAT_GREETING, RE_CHAT_SOCIAL, RE_CHAT_ACK, RE_CHAT_META, RE_CHAT_FACTUAL];
function classifyMessage(text) {
  const t = (text ?? "").trim();
  if (!t)
    return "chat";
  if (HEAVY_RULES.some((re) => re.test(t)))
    return "heavy";
  if (CHAT_RULES.some((re) => re.test(t)))
    return "chat";
  if (t.length > 300)
    return "heavy";
  return "ambiguous";
}

class ModelRouter {
  config;
  chat;
  heavy;
  offline;
  strategy;
  chatMaxInputTokens;
  chatMaxInputTokensPerMinute;
  heavyMaxInputTokens;
  heavyMaxInputTokensPerMinute;
  classifierOverride;
  constructor(config, opts = {}) {
    this.config = config;
    this.chatMaxInputTokens = opts.maxInputTokens;
    this.chatMaxInputTokensPerMinute = opts.maxInputTokensPerMinute;
    this.heavyMaxInputTokens = config.routing?.heavyMaxInputTokens;
    this.heavyMaxInputTokensPerMinute = config.routing?.heavyMaxInputTokensPerMinute;
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
    const safeHeavy = (() => {
      try {
        const side = this.buildSide(heavyName, heavyModel);
        return side;
      } catch {
        return { ...this.chat };
      }
    })();
    this.heavy = safeHeavy;
    const offlineName = routing?.offlineProvider;
    const offlineModel = routing?.offlineModel;
    if (offlineName) {
      try {
        this.offline = this.buildSide(offlineName, offlineModel || this.chat.model);
      } catch {
        this.offline = undefined;
      }
    }
  }
  buildSide(name, model) {
    const r = createProvider(this.config, name);
    const validModels = this.config.providers[name]?.models ?? [r.model];
    const chosen = validModels.includes(model) ? model : r.model;
    return { provider: r.provider, providerName: r.name, model: chosen };
  }
  setChat(name, model) {
    try {
      this.chat = this.buildSide(name, model ?? this.chat.model);
      return true;
    } catch {
      return false;
    }
  }
  setHeavy(name, model) {
    try {
      this.heavy = this.buildSide(name, model ?? this.heavy.model);
      return true;
    } catch {
      return false;
    }
  }
  setClassifier(fn) {
    this.classifierOverride = fn;
  }
  names() {
    return { chat: this.chat.providerName, heavy: this.heavy.providerName };
  }
  chatIdentity() {
    return { provider: this.chat.providerName, model: this.chat.model };
  }
  heavyIdentity() {
    return { provider: this.heavy.providerName, model: this.heavy.model };
  }
  offlineIdentity() {
    if (!this.offline)
      return null;
    return { provider: this.offline.providerName, model: this.offline.model };
  }
  isHeavy(route) {
    return route.providerName === this.heavy.providerName && route.model === this.heavy.model;
  }
  async resolve(userMessage, mode, taskActive = false) {
    if (mode === "chat")
      return this.route("chat", userMessage);
    if (mode === "heavy")
      return this.route("heavy", userMessage);
    const c = classifyMessage(userMessage);
    if (c === "heavy")
      return this.route("heavy", userMessage);
    if (c === "chat")
      return this.route("chat", userMessage);
    if (taskActive)
      return this.route("heavy", userMessage);
    if (this.strategy === "hybrid") {
      const verdict = await this.classifyWithQwen(userMessage);
      return this.route(verdict, userMessage);
    }
    return this.route("chat", userMessage);
  }
  resolveOffline(_userMessage) {
    const side = this.offline ?? this.chat;
    return {
      provider: side.provider,
      providerName: side.providerName,
      model: side.model,
      maxInputTokens: this.offline ? 4000 : this.chatMaxInputTokens,
      maxInputTokensPerMinute: this.offline ? undefined : this.chatMaxInputTokensPerMinute,
      offline: true
    };
  }
  route(kind, _userMessage) {
    const side = kind === "chat" ? this.chat : this.heavy;
    const heavy = kind === "heavy";
    return {
      provider: side.provider,
      providerName: side.providerName,
      model: side.model,
      maxInputTokens: heavy ? this.heavyMaxInputTokens : this.chatMaxInputTokens,
      maxInputTokensPerMinute: heavy ? this.heavyMaxInputTokensPerMinute : this.chatMaxInputTokensPerMinute
    };
  }
  async classifyWithQwen(text) {
    if (this.classifierOverride) {
      try {
        return await this.classifierOverride(text);
      } catch {
        return "chat";
      }
    }
    const messages = [
      { role: "system", content: CLASSIFIER_SYSTEM },
      { role: "user", content: text }
    ];
    const opts = { model: this.chat.model, messages, max_tokens: 4, temperature: 0, timeoutMs: 1e4, timeoutIdleMs: 8000 };
    try {
      const res = await this.chat.provider.streamChat(opts, () => {});
      const word = (res.text ?? "").trim().toLowerCase();
      if (word.includes("heavy"))
        return "heavy";
      if (word.includes("chat"))
        return "chat";
    } catch {}
    return "chat";
  }
}

// src/llm/connectivity.ts
async function isOnline(opts) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(opts.probeUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow"
    });
    return true;
  } catch {
    return false;
  }
}
function createConnectivityPoller(opts, onChange) {
  const pollMs = opts.pollMs ?? 15000;
  let online = false;
  let timer = null;
  let stopped = false;
  const probe = async () => {
    const now = await isOnline(opts);
    if (now !== online) {
      online = now;
      if (!stopped)
        onChange(online);
    }
    return now;
  };
  return {
    get online() {
      return online;
    },
    start() {
      stopped = false;
      probe();
      if (!timer)
        timer = setInterval(() => void probe(), pollMs);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async checkNow() {
      return probe();
    }
  };
}

// src/tools/registry.ts
var registry = new Map;
function registerTool(tool) {
  registry.set(tool.definition.function.name, tool);
}
function listTools() {
  return [...registry.values()].map((t) => t.definition);
}
async function executeTool(name, args, ctx) {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(`Unknown tool "${name}". Available: ${[...registry.keys()].join(", ")}`);
  }
  try {
    return await tool.run(args, ctx);
  } catch (err) {
    return `ERROR: ${err?.message ?? String(err)}`;
  }
}

// src/agent/tool-call.ts
function normalizeToolCalls(toolCalls, seed = 1) {
  return toolCalls.map((tc, i) => ({
    ...tc,
    id: tc.id || `call_${seed}_${i}`
  }));
}
function parseToolCalls(toolCalls) {
  return toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    args: parseToolArguments(tc.arguments)
  }));
}

// src/llm/tokens.ts
function estimateTokens(text) {
  if (!text)
    return 0;
  let t = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 11904 && c <= 40959 || c >= 13312 && c <= 19903 || c >= 63744 && c <= 64255)
      t += 1;
    else if (c === 32 || c === 10 || c === 9 || c === 13)
      t += 0.5;
    else if (c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57)
      t += 0.25;
    else
      t += 0.55;
  }
  return Math.ceil(t) + 1;
}
var MSG_OVERHEAD = 4;
function estimateMessageTokens(m) {
  let total = MSG_OVERHEAD;
  if (m.content)
    total += estimateTokens(m.content);
  if (m.tool_calls && m.tool_calls.length)
    total += estimateTokens(JSON.stringify(m.tool_calls));
  return total;
}
function estimateMessagesTokens(messages) {
  return messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
}
function cloneMessage(m) {
  return {
    ...m,
    content: m.content,
    tool_calls: m.tool_calls ? m.tool_calls.map((tc) => ({ ...tc })) : undefined
  };
}
function splitBlocks(nonSystem) {
  const blocks = [];
  let i = 0;
  while (i < nonSystem.length) {
    const m = nonSystem[i];
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
      const b = [i];
      i++;
      while (i < nonSystem.length && nonSystem[i].role === "tool") {
        b.push(i);
        i++;
      }
      blocks.push(b);
    } else if (m.role === "tool") {
      const b = [i];
      i++;
      while (i < nonSystem.length && nonSystem[i].role === "tool") {
        b.push(i);
        i++;
      }
      blocks.push(b);
    } else {
      blocks.push([i]);
      i++;
    }
  }
  return blocks;
}
function trimMessages(messages, opts) {
  if (!messages.length)
    return { messages, trimmed: 0, truncatedChars: 0 };
  const budget = opts.budgetTokens - (opts.reservedTokens ?? 0);
  const system = [];
  const nonSystem = [];
  for (const m of messages)
    (m.role === "system" ? system : nonSystem).push(m);
  const blockTokens = (idx) => blocks[idx].reduce((s, j) => s + estimateMessageTokens(nonSystem[j]), 0);
  const blocks = splitBlocks(nonSystem);
  if (!blocks.length) {
    return { messages: system.map(cloneMessage), trimmed: messages.length - system.length, truncatedChars: 0 };
  }
  if (budget < 1) {
    const lastIdx = blocks[blocks.length - 1];
    const kept2 = lastIdx.map((j) => cloneMessage(nonSystem[j]));
    return { messages: [...system.map(cloneMessage), ...kept2], trimmed: messages.length - (system.length + kept2.length), truncatedChars: 0 };
  }
  let used = system.reduce((s, m) => s + estimateMessageTokens(m), 0);
  const firstUserBlock = blocks.findIndex((b) => nonSystem[b[0]].role === "user");
  const newestBlock = blocks.length - 1;
  const keepBlock = new Set([newestBlock]);
  if (firstUserBlock >= 0 && firstUserBlock !== newestBlock)
    keepBlock.add(firstUserBlock);
  for (const bi of keepBlock)
    used += blockTokens(bi);
  for (let bi = blocks.length - 1;bi >= 0; bi--) {
    if (keepBlock.has(bi))
      continue;
    const bt = blockTokens(bi);
    if (used + bt > budget)
      continue;
    keepBlock.add(bi);
    used += bt;
  }
  const kept = system.map(cloneMessage);
  for (let bi = 0;bi < blocks.length; bi++) {
    if (!keepBlock.has(bi))
      continue;
    for (const j of blocks[bi])
      kept.push(cloneMessage(nonSystem[j]));
  }
  const truncatedChars = truncateToFit(kept, budget);
  return { messages: kept, trimmed: messages.length - kept.length, truncatedChars };
}
function truncateToFit(messages, budget) {
  let used = estimateMessagesTokens(messages);
  if (used <= budget)
    return 0;
  let truncated = 0;
  for (let i = 0;i < messages.length - 1; i++) {
    const m = messages[i];
    if (m.role === "system" || !m.content)
      continue;
    truncated += m.content.length;
    m.content = "";
    used = estimateMessagesTokens(messages);
    if (used <= budget)
      return truncated;
  }
  const newest = messages[messages.length - 1];
  if (newest.content && used > budget) {
    const overflow = used - budget;
    const remove = Math.min(newest.content.length, Math.max(50, Math.ceil(overflow * 4)));
    if (remove > 0 && remove < newest.content.length) {
      newest.content = newest.content.slice(0, newest.content.length - remove) + `
…[trimmed]`;
      truncated += remove;
    }
  }
  return truncated;
}

// src/llm/pace.ts
class RatePacer {
  cap;
  windowMs;
  now;
  history = [];
  constructor(cap, windowMs = 60000, now = Date.now) {
    this.cap = cap;
    this.windowMs = windowMs;
    this.now = now;
  }
  record(tokens) {
    this.prune();
    this.history.push({ at: this.now(), tokens });
  }
  waitMs(nextTokens) {
    this.prune();
    let sum = nextTokens;
    for (const h of this.history)
      sum += h.tokens;
    if (sum <= this.cap)
      return 0;
    const over = sum - this.cap;
    const rate = this.cap / this.windowMs;
    return Math.min(60000, Math.ceil(over / rate));
  }
  prune() {
    const cutoff = this.now() - this.windowMs;
    this.history = this.history.filter((h) => h.at >= cutoff);
  }
}
async function paceWait(pacer, tokens, signal) {
  if (!pacer)
    return;
  const ms = pacer.waitMs(tokens);
  if (ms <= 0)
    return;
  await sleepAbortable(ms, signal ?? new AbortController().signal);
}

// src/agent/loop.ts
async function runAgent(options, callbacks = {}) {
  const maxSteps = callbacks.maxSteps ?? 40;
  const messages = [{ role: "system", content: options.systemPrompt }, ...options.initialMessages];
  const toolDefs = listTools();
  let toolCalls = 0;
  const systemTokens = options.maxInputTokens ? estimateTokens(options.systemPrompt) : 0;
  const toolsJson = options.maxInputTokens && toolDefs.length ? JSON.stringify(toolDefs) : "";
  const toolsTokens = options.maxInputTokens ? estimateTokens(toolsJson) : 0;
  const SAFETY_FACTOR = 1.3;
  let retryBudgetDelta = 0;
  const effectiveBudget = () => options.maxInputTokens ? Math.floor(options.maxInputTokens / SAFETY_FACTOR) : 0;
  const effectiveReserved = () => Math.floor((systemTokens + toolsTokens) / SAFETY_FACTOR) + retryBudgetDelta;
  const estimateRequestTokens = () => (options.maxInputTokens ? systemTokens + toolsTokens : 0) + estimateMessagesTokens(messages);
  const pacer = options.maxInputTokensPerMinute ? new RatePacer(options.maxInputTokensPerMinute) : null;
  const MAX_STEP_RETRIES = 2;
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;
  const stepSummaries = [];
  for (let step = 0;step < maxSteps; step++) {
    if (options.signal?.aborted) {
      callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
      return { finalText: `
[interrupted]`, toolCalls, steps: step, aborted: true };
    }
    let result = null;
    let stepOk = false;
    for (let attempt = 0;attempt <= MAX_STEP_RETRIES && !stepOk; attempt++) {
      retryBudgetDelta = 0;
      for (;; ) {
        if (options.maxInputTokens) {
          const trim = trimMessages(messages, {
            budgetTokens: effectiveBudget(),
            reservedTokens: effectiveReserved()
          });
          messages.length = 0;
          messages.push(...trim.messages);
          if (trim.trimmed > 0 && retryBudgetDelta === 0)
            callbacks.onTrimmed?.(trim.trimmed, trim.truncatedChars);
        }
        const chatOpts = {
          model: options.model,
          messages,
          tools: toolDefs,
          signal: options.signal,
          ...options.chatOptions
        };
        try {
          await paceWait(pacer, estimateRequestTokens(), options.signal);
          result = await options.provider(chatOpts, (chunk) => {
            if (chunk.reasoning)
              callbacks.onReasoning?.(chunk.reasoning);
            if (chunk.content)
              callbacks.onModelText?.(chunk.content);
          });
          if (pacer)
            pacer.record(estimateRequestTokens());
          stepOk = true;
          break;
        } catch (err) {
          if (err instanceof ContextTooLargeError && retryBudgetDelta === 0) {
            retryBudgetDelta = 512;
            continue;
          }
          if (options.signal?.aborted || err?.name === "AbortError") {
            callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
            return { finalText: `
[interrupted]`, toolCalls, steps: step, aborted: true };
          }
          break;
        }
      }
    }
    if (!stepOk || !result) {
      consecutiveFailures++;
      const failMsg = `[step ${step + 1}: LLM call failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive)]`;
      callbacks.onModelText?.(`
${failMsg}
`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const summary = stepSummaries.length ? `
Last steps: ${stepSummaries.slice(-3).join("; ")}` : "";
        const finalMsg = `(stopped after ${consecutiveFailures} consecutive LLM failures — check your network and provider status.${summary})`;
        callbacks.onModelText?.(`${finalMsg}
`);
        callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "error" });
        return {
          finalText: finalMsg,
          toolCalls,
          steps: step,
          aborted: false
        };
      }
      continue;
    }
    consecutiveFailures = 0;
    if (result.text) {
      messages.push({ role: "assistant", content: result.text });
    } else if (result.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: null });
    }
    if (result.toolCalls.length === 0) {
      callbacks.onDone?.(result);
      return { finalText: result.text, toolCalls, steps: step + 1, aborted: false };
    }
    const normalizedCalls = normalizeToolCalls(result.toolCalls, step + 1);
    const assistantMsg = {
      role: "assistant",
      content: result.text || null,
      tool_calls: normalizedCalls.map((tc) => ({ ...tc }))
    };
    if (messages[messages.length - 1]?.role === "assistant") {
      messages[messages.length - 1] = assistantMsg;
    } else {
      messages.push(assistantMsg);
    }
    const parsed = parseToolCalls(normalizedCalls);
    for (const call of parsed) {
      toolCalls++;
      if (!call.name) {
        const id = call.id || `call_${toolCalls}`;
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: "ERROR: the model emitted a tool call with no function name. Reissue a valid tool call or finish by responding with plain text.",
          name: "unknown"
        });
        continue;
      }
      callbacks.onToolStart?.(call.name, call.args);
      let output;
      let approved = true;
      if (callbacks.confirmTool) {
        approved = await callbacks.confirmTool(call.name, call.args);
      }
      if (!approved) {
        output = "(tool call rejected by user — inform the user and adjust your approach)";
      } else {
        try {
          output = await executeTool(call.name, call.args, options.toolCtx);
        } catch (err) {
          output = `ERROR: ${err?.message ?? String(err)}`;
        }
      }
      callbacks.onToolEnd?.(call.name, output);
      messages.push({ role: "tool", tool_call_id: call.id, content: output, name: call.name });
    }
    const stepToolNames = parsed.filter((c) => c.name).map((c) => c.name);
    if (stepToolNames.length) {
      stepSummaries.push(`step ${step + 1}: ${stepToolNames.join(", ")}`);
      if (stepSummaries.length > 20)
        stepSummaries.shift();
    }
  }
  const progressLines = [];
  if (stepSummaries.length) {
    progressLines.push("Progress:");
    for (const s of stepSummaries.slice(-8))
      progressLines.push("  " + s);
  }
  const maxMsg = progressLines.length > 0 ? `(reached max steps without completion.
${progressLines.join(`
`)}
${stepSummaries.length} step(s) ran, ${toolCalls} tool call(s). Try a more focused task or raise --max-steps.)` : `(reached max steps without completion. ${toolCalls} tool call(s) were attempted.)`;
  callbacks.onModelText?.(`
${maxMsg}
`);
  callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "max_steps" });
  return { finalText: maxMsg, toolCalls, steps: maxSteps, aborted: false };
}

// src/queue.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, rmSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3, dirname as dirname2 } from "node:path";
var _root = null;
var FILE_OVERRIDE = null;
function expandHome(p) {
  if (p === "~")
    return homedir2();
  if (p.startsWith("~/"))
    return join3(homedir2(), p.slice(2));
  return p;
}
function root() {
  if (_root)
    return _root;
  const envDir = process.env.VIBECODER_SESSION_DIR;
  _root = envDir || join3(homedir2(), ".vibecoder");
  mkdirSync2(_root, { recursive: true });
  return _root;
}
function setQueueFileOverride(path) {
  FILE_OVERRIDE = path ? expandHome(path) : null;
  _root = null;
}
function queueFile() {
  if (FILE_OVERRIDE)
    return FILE_OVERRIDE;
  return join3(root(), "queue.json");
}
function read() {
  const f = queueFile();
  if (!existsSync3(f))
    return [];
  try {
    const arr = JSON.parse(readFileSync3(f, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function write(tasks) {
  mkdirSync2(dirname2(queueFile()), { recursive: true });
  writeFileSync2(queueFile(), JSON.stringify(tasks, null, 2));
}
function newId() {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
var LOCK_STALE_MS = 2000;
var LOCK_ACQUIRE_TIMEOUT_MS = 5000;
function lockPath() {
  return `${queueFile()}.lock`;
}
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function acquireLock() {
  const lp = lockPath();
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;; ) {
    try {
      mkdirSync2(lp);
      return;
    } catch {}
    try {
      if (Date.now() - statSync(lp).mtimeMs > LOCK_STALE_MS && existsSync3(lp)) {
        rmSync(lp, { recursive: true, force: true });
        continue;
      }
    } catch {}
    if (Date.now() > deadline) {
      throw new Error("task queue is busy (lock held) — try again");
    }
    syncSleep(25);
  }
}
function releaseLock() {
  try {
    rmSync(lockPath(), { recursive: true, force: true });
  } catch {}
}
function withLock(fn) {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}
function enqueueTask(input) {
  const task = {
    id: newId(),
    userMessage: input.userMessage,
    planNote: input.planNote,
    cwd: input.cwd,
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    createdAt: Date.now(),
    status: "queued"
  };
  return withLock(() => {
    const tasks = read();
    tasks.push(task);
    write(tasks);
    return task;
  });
}
function listTasks(status) {
  const all = read();
  const out = status ? all.filter((t) => t.status === status) : all;
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
function nextQueued() {
  const tasks = read();
  const candidates = tasks.filter((t) => t.status === "queued" || t.status === "running" && t.runnerPid && !processExists(t.runnerPid)).sort((a, b) => a.createdAt - b.createdAt);
  return candidates[0] ?? null;
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function update(id, patch) {
  const tasks = read();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1)
    return null;
  tasks[idx] = { ...tasks[idx], ...patch };
  write(tasks);
  return tasks[idx];
}
function claimTask(id) {
  return withLock(() => {
    const tasks = read();
    const t = tasks.find((x) => x.id === id);
    if (!t)
      return null;
    if (t.status === "running" && t.runnerPid && processExists(t.runnerPid))
      return null;
    t.status = "running";
    t.runnerPid = process.pid;
    t.startedAt = Date.now();
    write(tasks);
    return { ...t };
  });
}
function markTaskDone(id, result) {
  return withLock(() => update(id, { status: "done", result, finishedAt: Date.now(), runnerPid: undefined, error: undefined }));
}
function markTaskFailed(id, error) {
  return withLock(() => update(id, { status: "failed", error, finishedAt: Date.now(), runnerPid: undefined }));
}

// src/tools/proc.ts
import { spawn } from "node:child_process";
function killProcessGroup(child, signal = "SIGKILL") {
  if (child.pid === undefined || child.pid <= 0)
    return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}
function spawnCollect(opts) {
  return new Promise((resolvePromise) => {
    const child = spawn(opts.cmd[0], opts.cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: opts.detached ?? true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => stdout += d.toString());
    child.stderr?.on("data", (d) => stderr += d.toString());
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError = "";
    let timer = null;
    const settle = (exitCode) => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (spawnError) {
        stderr = (stderr ? stderr + `
` : "") + `spawn error: ${spawnError}`;
      }
      resolvePromise({ stdout, stderr, exitCode, timedOut, aborted });
    };
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        opts.onTimeout?.();
        killProcessGroup(child);
      }, opts.timeoutMs);
    }
    const onAbort = () => {
      aborted = true;
      killProcessGroup(child);
    };
    if (opts.signal?.aborted)
      onAbort();
    else
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => settle(code ?? -1));
    child.on("error", (err) => {
      spawnError = err.message;
      settle(-1);
    });
  });
}

// src/tools/bash.ts
var MAX_OUTPUT = 30000;
var PLAN_MODE_BANNED = [
  { re: /(^|[;&|]\s*)(rm|rmdir|mv|dd|mkfs(\.[a-z0-9]+)?|truncate|fdisk|parted|mkfs)\s/, why: "file/directory-destroying command" },
  { re: /(^|[;&|]\s*)git\s+(reset\s+--hard|clean\s+-(f|d|fd)|checkout\s+\S+\s+--?[^;]*|push\b|remote\s+set-url|branch\s+-D|stash\s+drop|rebase\b|merge\b|cherry-pick\b)/, why: "git state mutation" },
  { re: /(^|[;&|]\s*)(npm|pnpm|yarn|bun|deno)\s+(i|install|add|update|remove|uninstall|upgrade)\b/, why: "package manager install/remove" },
  { re: /(^|[;&|]\s*)(pip|pip3)\s+(install|uninstall|download)\b/, why: "pip install/remove" },
  { re: /(^|[;&|]\s*)(apt|apt-get|dnf|yum|zypper|brew)\s+(install|remove|uninstall|purge|update|upgrade)\b/, why: "system package manager" },
  { re: /(^|[;&|]\s*)(cargo|go)\s+(install|add)\b/, why: "language package manager" },
  { re: /\b(kill|pkill|killall|systemctl|service|reboot|shutdown|halt|poweroff|init|swapoff|mkswap)\b/, why: "process/system control" },
  { re: /(^|[;&|]\s*)sudo\b/, why: "sudo" },
  { re: /\s(>|>>|2>)\s*/, why: "output redirection writes a file" },
  { re: /\btee\s+-?a?\s+/, why: "tee writes to a file" }
];
function bannedReason(command) {
  const c = command.trim();
  for (const { re, why } of PLAN_MODE_BANNED) {
    if (re.test(`
` + c + `
`))
      return why;
  }
  return null;
}
registerTool({
  definition: {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command. Use for executing commands, running scripts, git, package managers, etc. Returns stdout+stderr. Set workdir via the workdir param instead of 'cd X && ...'.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" },
          workdir: { type: "string", description: "Working directory to run in (optional)" },
          timeout: { type: "number", description: "Timeout in milliseconds (optional, default 120000)" }
        },
        required: ["command"]
      }
    }
  },
  async run(args, ctx) {
    const command = String(args.command ?? "");
    if (ctx.planPhase) {
      const why = bannedReason(command);
      if (why)
        return `BLOCKED IN PLAN MODE (read-only): ${why}. Use read-only commands (ls, grep, cat, git status/diff/log, running tests) to investigate, and describe any changes you would make in your PLAN instead.`;
    }
    const cwd = args.workdir ? String(args.workdir) : ctx.cwd;
    const timeout = Math.max(0, Number(args.timeout ?? 120000));
    const res = await spawnCollect({
      cmd: ["bash", "-lc", command],
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      timeoutMs: timeout,
      signal: ctx.signal
    });
    let output = "";
    if (res.stdout)
      output += res.stdout;
    if (res.stderr)
      output += res.stderr ? (output ? `
` : "") + res.stderr : "";
    if (res.exitCode !== 0)
      output += (output ? `
` : "") + `[exit code: ${res.exitCode}]`;
    if (res.timedOut)
      output += (output ? `
` : "") + `[killed: timed out after ${timeout}ms]`;
    if (res.aborted)
      output += (output ? `
` : "") + "[killed: interrupted]";
    if (!output)
      output = "(no output)";
    if (output.length > MAX_OUTPUT) {
      const keep = MAX_OUTPUT - 200;
      const trimmed = output.length - keep;
      output = `...[trimmed ${trimmed} chars from beginning]
` + output.slice(output.length - keep);
    }
    return output;
  }
});

// src/tools/fs-utils.ts
import * as path from "path";
function resolve2(p, ctx) {
  if (p.startsWith("/"))
    return path.resolve(p);
  return path.resolve(ctx.cwd, p);
}

// src/tools/files.ts
import { dirname as dirname4, join as join5 } from "node:path";
import { mkdirSync as mkdirSync4, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";

// src/self-edit.ts
import { createHash } from "node:crypto";
import { copyFileSync, existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync4, appendFileSync, readdirSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4, resolve as resolve3, dirname as dirname3 } from "node:path";
import { spawnSync } from "node:child_process";
var LEDGER_NAME = "SELF_EDITS.jsonl";
function repoRoot() {
  const env = process.env.VIBECODER_REPO_ROOT;
  if (env)
    return resolve3(env);
  return dirname3(packageRoot());
}
function installMode() {
  if (process.env.VIBECODER_REPO_ROOT)
    return "repo";
  const root2 = dirname3(packageRoot());
  if (existsSync4(join4(root2, ".git")) || existsSync4(join4(packageRoot(), ".git")))
    return "repo";
  return "user";
}
function userDataRoot() {
  if (process.env.VIBECODER_SESSION_DIR)
    return process.env.VIBECODER_SESSION_DIR;
  return join4(homedir3(), ".vibecoder");
}
function repoConfigFile() {
  return resolvePackageFile("config.json");
}
function liveConfigFile() {
  const repo = reposWhere();
  if (repo && installMode() === "repo")
    return repo.config;
  const repoCfg = repoConfigFile();
  if (installMode() === "repo" && repoCfg && !existsSync4(userConfigFile()))
    return repoCfg;
  return userConfigFile();
}
function ledgerPath() {
  return installMode() === "repo" ? join4(repoRoot(), LEDGER_NAME) : join4(userDataRoot(), LEDGER_NAME);
}
function backupsDir() {
  return join4(userDataRoot(), "backups");
}
function isSameFile(a, b) {
  return resolve3(a) === resolve3(b);
}
function reposWhere() {
  if (process.env.VIBECODER_REPO_ROOT) {
    const root2 = resolve3(process.env.VIBECODER_REPO_ROOT);
    return { root: root2, config: join4(root2, "config.json"), env: join4(root2, ".env") };
  }
  return null;
}
function isSelfFile(abs) {
  const a = resolve3(abs);
  const repo = reposWhere();
  if (repo && (isSameFile(a, repo.config) || isSameFile(a, repo.env)))
    return true;
  if (isSameFile(a, liveConfigFile()))
    return true;
  return false;
}
function isProtectedFile(abs) {
  return isSameFile(abs, ledgerPath());
}
function shaOf(text) {
  return createHash("sha256").update(text).digest("hex");
}
function readIfExists(abs) {
  try {
    return existsSync4(abs) ? readFileSync4(abs, "utf8") : "";
  } catch {
    return "";
  }
}
function appendLedger(entry) {
  try {
    const full = { ts: new Date().toISOString(), ...entry };
    mkdirSync3(dirname3(ledgerPath()), { recursive: true });
    appendFileSync(ledgerPath(), JSON.stringify(full) + `
`, "utf8");
    return true;
  } catch {
    return false;
  }
}
function readLedger(limit = 20) {
  try {
    if (!existsSync4(ledgerPath()))
      return [];
    const lines = readFileSync4(ledgerPath(), "utf8").split(`
`).filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter((e) => e !== null);
  } catch {
    return [];
  }
}
function ledgerSummary(limit = 5) {
  return readLedger(limit).map((e) => {
    const same = e.beforeSha === e.afterSha ? "no-content-change" : "changed";
    return `  ${e.ts.slice(0, 19)} ${e.tool} ${e.file} ${same} — ${e.note}`;
  });
}
function snapshotConfig(content) {
  const dir = backupsDir();
  mkdirSync3(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join4(dir, `config-${ts}.json`);
  writeFileSync3(file, content, "utf8");
  return file;
}
function newestBackup() {
  try {
    const dir = backupsDir();
    if (!existsSync4(dir))
      return null;
    const files = readdirSync(dir).filter((f) => f.startsWith("config-") && f.endsWith(".json")).sort();
    return files.length ? join4(dir, files[files.length - 1]) : null;
  } catch {
    return null;
  }
}
function auditSelfEdit(toolName, abs, beforeText, afterText, note) {
  if (installMode() === "user" && isSameFile(abs, liveConfigFile())) {
    snapshotConfig(beforeText);
  }
  const display = isSameFile(abs, liveConfigFile()) ? "config.json" : abs;
  const ok = appendLedger({ tool: toolName, file: display, beforeSha: shaOf(beforeText), afterSha: shaOf(afterText), note });
  if (!ok) {
    return `WARNING: SELF-EDIT on ${display} (${toolName}) could NOT be written to ${LEDGER_NAME} — treat it as UNAUDITED and re-run with write access.`;
  }
  return `SELF-EDIT recorded to ${LEDGER_NAME} (file ${display}): staged, not live. Tell the human it needs /reload-config to go live, or /undo-self-edits to revert.`;
}
function restoreSelfFiles() {
  const target = liveConfigFile();
  const repoCfg = reposWhere()?.config ?? repoConfigFile();
  if (installMode() === "repo" && repoCfg && isSameFile(target, repoCfg)) {
    const res = spawnSync("git", ["restore", "--worktree", "--", "config.json"], {
      cwd: repoRoot(),
      encoding: "utf8"
    });
    const out = (res.stdout || "") + (res.stderr || "");
    return { ok: res.status === 0, out: out.trim() };
  }
  const backup = newestBackup();
  if (!backup) {
    return { ok: false, out: "no snapshot found in ~/.vibecoder/backups — nothing to restore" };
  }
  try {
    mkdirSync3(dirname3(target), { recursive: true });
    copyFileSync(backup, target);
    return { ok: true, out: `restored ${target} from snapshot ${backup}` };
  } catch (err) {
    return { ok: false, out: String(err?.message ?? err) };
  }
}
function selfFileDiffStat() {
  const target = liveConfigFile();
  const repoCfg = reposWhere()?.config ?? repoConfigFile();
  if (installMode() === "repo" && repoCfg && isSameFile(target, repoCfg)) {
    const res = spawnSync("git", ["diff", "--stat", "--", "config.json"], { cwd: repoRoot(), encoding: "utf8" });
    return (res.stdout || res.stderr || "").trim();
  }
  const backup = newestBackup();
  if (!existsSync4(target))
    return "";
  if (!backup)
    return readIfExists(target) ? "config.json is present (no snapshot yet)" : "";
  const current = readIfExists(target);
  const prev = readIfExists(backup);
  if (current === prev)
    return "";
  const changed = current.split(`
`).filter((l) => !prev.split(`
`).includes(l)).length;
  return `config.json changed since last snapshot (${backup.split("/").pop()}) — ~${changed} line(s) differ`;
}

// src/tools/files.ts
async function fileText(p) {
  try {
    return await readFileAsync(p, "utf8");
  } catch {
    return "";
  }
}
async function fileExists(p) {
  try {
    await readFileAsync(p);
    return true;
  } catch {
    return false;
  }
}
function protectedError(p) {
  return `ERROR: SELF-EDIT PROTECTED — ${p} is the append-only audit ledger. It cannot be modified or deleted; self-edits are recorded there automatically.`;
}
async function preWriteNote(p, content) {
  if (isProtectedFile(p))
    return { ok: false, note: protectedError(p) };
  if (isSelfFile(p)) {
    const before = await fileExists(p) ? await fileText(p) : "";
    return { ok: true, note: auditSelfEdit("write_file", p, before, content, `wrote ${content.length} bytes`) };
  }
  return { ok: true, note: "" };
}
function formatSize(n) {
  if (n < 1024)
    return `${n}B`;
  if (n < 1024 * 1024)
    return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}
registerTool({
  definition: {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the contents of a directory (non-recursive). Subdirectories are shown first with a trailing slash, then files with their size.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list (optional, defaults to the working directory)" }
        },
        required: []
      }
    }
  },
  async run(args, ctx) {
    const p = args.path ? resolve2(String(args.path), ctx) : ctx.cwd;
    let entries;
    try {
      entries = readdirSync2(p, { withFileTypes: true });
    } catch (err) {
      return `ERROR: cannot list directory: ${err?.message ?? String(err)}`;
    }
    const rows = [];
    for (const e of entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory())
        return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })) {
      if (e.isDirectory()) {
        rows.push(`${e.name}/`);
      } else if (e.isFile()) {
        let size = "";
        try {
          const st = statSync2(join5(p, e.name));
          size = formatSize(st.size);
        } catch {
          size = "?";
        }
        rows.push(`${e.name}	${size}`);
      } else {
        rows.push(`${e.name}  (${e.isSymbolicLink() ? "symlink" : "special"})`);
      }
    }
    return rows.length ? rows.join(`
`) : `(empty directory: ${p})`;
  }
});
registerTool({
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk. Reads up to 2000 lines from the start, or from the given offset. Use for understanding existing code.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          offset: { type: "number", description: "Line number to start reading from (optional)" },
          limit: { type: "number", description: "Max lines to read (optional)" }
        },
        required: ["path"]
      }
    }
  },
  async run(args, ctx) {
    const p = resolve2(String(args.path), ctx);
    if (!await fileExists(p))
      return `ERROR: file not found: ${p}`;
    const text = await fileText(p);
    const lines = text.split(`
`);
    const offset = Math.max(1, Number(args.offset ?? 1) || 1);
    const limit = Math.max(0, Number(args.limit ?? 2000) || 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return slice.map((l, i) => `${offset + i}: ${l}`).join(`
`);
  }
});
registerTool({
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, overwriting it. Creates parent directories. Use for creating new files or complete rewrites. The full file content must be provided.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          content: { type: "string", description: "Full file content to write" }
        },
        required: ["path", "content"]
      }
    }
  },
  async run(args, ctx) {
    if (ctx.planPhase)
      return `BLOCKED IN PLAN MODE: write_file is disabled while investigating. Record what you would write in your PLAN (FILES: ...) instead; the human approves before any file is touched.`;
    const p = resolve2(String(args.path), ctx);
    const content = String(args.content ?? "");
    const guard = await preWriteNote(p, content);
    if (!guard.ok)
      return guard.note;
    mkdirSync4(dirname4(p), { recursive: true });
    await writeFileAsync(p, content, "utf8");
    return `Wrote ${content.length} bytes to ${p}${guard.note ? `
` + guard.note : ""}`;
  }
});
registerTool({
  definition: {
    type: "function",
    function: {
      name: "edit_file",
      description: "Perform an exact string replacement in a file. Use to modify part of a file without rewriting the whole thing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          oldString: { type: "string", description: "The exact text to find and replace" },
          newString: { type: "string", description: "The replacement text" }
        },
        required: ["path", "oldString", "newString"]
      }
    }
  },
  async run(args, ctx) {
    if (ctx.planPhase)
      return `BLOCKED IN PLAN MODE: edit_file is disabled while investigating. Describe the exact change in your PLAN instead; the human approves before any file is touched.`;
    const p = resolve2(String(args.path), ctx);
    const oldString = String(args.oldString ?? "");
    const newString = String(args.newString ?? "");
    if (!await fileExists(p))
      return `ERROR: file not found: ${p}`;
    if (isProtectedFile(p))
      return protectedError(p);
    const text = await fileText(p);
    if (!oldString)
      return `ERROR: oldString cannot be empty`;
    const count = text.split(oldString).length - 1;
    if (count === 0)
      return `ERROR: oldString not found in file`;
    if (count > 1)
      return `ERROR: found ${count} matches; provide more surrounding context (oldString must be unique)`;
    const updated = text.replace(oldString, newString);
    await writeFileAsync(p, updated, "utf8");
    const note = isSelfFile(p) ? auditSelfEdit("edit_file", p, text, updated, "replaced 1 occurrence") : "";
    return `Edited ${p}: replaced 1 occurrence${note ? `
` + note : ""}`;
  }
});

// src/tools/glob.ts
import { opendir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join as join6 } from "node:path";
var EXCLUDE_DEFAULTS = ["node_modules", ".git"];
function segmentToRegExp(seg) {
  let re = "^";
  for (let i = 0;i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") {
      if (seg[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end === -1)
        re += "\\[";
      else {
        re += seg.slice(i, end + 1);
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$");
}
async function globScan(pattern, opts) {
  const cwd = opts.cwd;
  try {
    await access(cwd);
  } catch (err) {
    throw err;
  }
  const onlyFiles = opts.onlyFiles ?? true;
  const maxResults = opts.maxResults ?? 2000;
  const maxScanned = opts.maxScanned ?? maxResults;
  const exclusions = new Set([...EXCLUDE_DEFAULTS, ...opts.excludeDirs ?? []]);
  let normalized = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  while (normalized.startsWith("/"))
    normalized = normalized.slice(1);
  if (!normalized)
    normalized = "**";
  const segs = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
  const out = [];
  let scanned = 0;
  let truncated = false;
  const push = (p) => {
    if (truncated)
      return;
    if (out.length >= maxResults) {
      truncated = true;
      return;
    }
    scanned++;
    out.push(p);
  };
  const hasMagic = (s) => /[*?[]/.test(s);
  const recurse = async (remaining, dir, rel) => {
    if (truncated || scanned >= maxScanned)
      return;
    const head = remaining[0];
    if (head === "**") {
      if (remaining.length === 1) {
        let entries3;
        try {
          entries3 = await opendir(dir);
        } catch {
          return;
        }
        for await (const e of entries3) {
          if (truncated || scanned >= maxScanned)
            break;
          if (exclusions.has(e.name))
            continue;
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          const childAbs = join6(dir, e.name);
          if (e.isDirectory()) {
            await recurse(remaining, childAbs, childRel);
          } else if (!onlyFiles || e.isFile()) {
            push(childRel);
          }
        }
        return;
      }
      await recurse(remaining.slice(1), dir, rel);
      let entries2;
      try {
        entries2 = await opendir(dir);
      } catch {
        return;
      }
      for await (const e of entries2) {
        if (truncated || scanned >= maxScanned)
          break;
        if (e.isDirectory() && !exclusions.has(e.name)) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          await recurse(remaining, join6(dir, e.name), childRel);
        }
      }
      return;
    }
    if (!head)
      return;
    const magic = hasMagic(head);
    const rx = magic ? segmentToRegExp(head) : new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      return;
    }
    for await (const e of entries) {
      if (truncated || scanned >= maxScanned)
        break;
      if (exclusions.has(e.name))
        continue;
      const isLast = remaining.length === 1;
      if (isLast) {
        if (onlyFiles && !e.isDirectory() && !e.isFile())
          continue;
        if (onlyFiles && e.isDirectory())
          continue;
        if (!onlyFiles && e.isDirectory()) {
          if (rx.test(e.name))
            push(rel ? `${rel}/${e.name}` : e.name);
          continue;
        }
        if (rx.test(e.name))
          push(rel ? `${rel}/${e.name}` : e.name);
      } else {
        if (!e.isDirectory())
          continue;
        if (rx.test(e.name)) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          await recurse(remaining.slice(1), join6(dir, e.name), childRel);
        }
      }
    }
  };
  await recurse(segs, cwd, "");
  return out;
}

// src/tools/search.ts
var MAX_RESULTS = 50;
var MAX_SCANNED = 2000;
var DEFAULT_TIMEOUT_MS = 60000;
registerTool({
  definition: {
    type: "function",
    function: {
      name: "glob",
      description: "List files matching a glob pattern (e.g. **/*.ts, src/**). Returns matching file paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to search" },
          cwd: { type: "string", description: "Directory to search in (optional, defaults to workspace)" }
        },
        required: ["pattern"]
      }
    }
  },
  async run(args, ctx) {
    const pattern = String(args.pattern ?? "");
    const dir = args.cwd ? String(args.cwd) : ctx.cwd;
    const matches = [];
    try {
      const found = await globScan(pattern, { cwd: dir, onlyFiles: true, maxResults: MAX_SCANNED });
      matches.push(...found);
    } catch (err) {
      return `ERROR: glob failed: ${err?.message ?? String(err)}`;
    }
    const list = matches.slice(0, MAX_RESULTS);
    let out = list.sort().join(`
`);
    if (list.length === 0)
      out = "(no matches)";
    else if (matches.length > MAX_RESULTS)
      out += `
...(${matches.length - MAX_RESULTS} more)`;
    return out;
  }
});
registerTool({
  definition: {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regex. Returns file paths and line numbers of matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          include: { type: "string", description: "File glob to filter (e.g. *.ts) (optional)" },
          path: { type: "string", description: "Directory to search (optional, defaults to workspace)" },
          timeout: { type: "number", description: "Timeout in milliseconds (optional, default 60000)" }
        },
        required: ["pattern"]
      }
    }
  },
  async run(args, ctx) {
    const pattern = String(args.pattern ?? "");
    const dir = args.path ? String(args.path) : ctx.cwd;
    const include = args.include ? String(args.include) : "*";
    const timeout = Math.max(0, Number(args.timeout ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    const res = await spawnCollect({
      cmd: [
        "grep",
        "-rn",
        "-E",
        "-e",
        pattern,
        `--include=${include}`,
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--",
        dir
      ],
      env: { ...process.env, NO_COLOR: "1" },
      timeoutMs: timeout,
      signal: ctx.signal
    });
    const lines = res.stdout.split(`
`).filter(Boolean);
    const shown = lines.slice(0, MAX_RESULTS);
    let result = shown.join(`
`);
    if (res.timedOut)
      result += `
[killed: timed out after ${timeout} ms]`;
    else if (res.aborted)
      result += `
[aborted]`;
    if (res.exitCode !== 0 && !lines.length)
      result += res.stderr.trim() ? `ERROR: ${res.stderr.trim()}` : "";
    if (!lines.length)
      result = result.trim() || "(no matches)";
    else if (lines.length > MAX_RESULTS)
      result += `
...(${lines.length - MAX_RESULTS} more)`;
    return result;
  }
});

// src/tools/net.ts
registerTool({
  definition: {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a URL (HTTP/HTTPS) and return its body as text, truncated to maxChars. Use to read documentation, API responses, or any web content.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          maxChars: { type: "number", description: "Max characters to return (optional, default 4000)" },
          timeoutMs: { type: "number", description: "Timeout in milliseconds (optional, default 20000)" }
        },
        required: ["url"]
      }
    }
  },
  async run(args, ctx) {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//i.test(url))
      return `ERROR: unsupported URL (must be http or https): ${url}`;
    const maxChars = Math.max(100, Number(args.maxChars ?? 4000) || 4000);
    const timeoutMs = Math.max(1000, Number(args.timeoutMs ?? 20000) || 20000);
    const ac = new AbortController;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    const onAbort = () => ac.abort();
    if (ctx.signal?.aborted)
      onAbort();
    else
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { redirect: "follow", signal: ac.signal });
      if (!res.ok)
        return `ERROR: HTTP ${res.status} ${res.statusText}`;
      const ctype = res.headers.get("content-type") ?? "";
      const announced = Number(res.headers.get("content-length"));
      const reader = res.body.getReader();
      const decoder = new TextDecoder;
      let body = "";
      let bytesRead = 0;
      let hitCap = false;
      try {
        for (;; ) {
          const { done, value } = await reader.read();
          if (done)
            break;
          bytesRead += value?.byteLength ?? 0;
          body += decoder.decode(value, { stream: true });
          if (body.length >= maxChars) {
            hitCap = true;
            break;
          }
        }
      } finally {
        if (hitCap)
          await reader.cancel?.().catch(() => {});
        reader.releaseLock?.();
      }
      const fullLen = Number.isFinite(announced) && announced > 0 ? Math.max(announced, bytesRead) : bytesRead;
      const truncated = fullLen > maxChars ? `
...(truncated, more available via maxChars)` : "";
      return `HTTP ${res.status} · content-type: ${ctype} · bytes: ${fullLen}${truncated}
${body.slice(0, maxChars)}`;
    } catch (err) {
      if (timedOut)
        return `ERROR: fetch timed out after ${timeoutMs}ms`;
      if (ac.signal.aborted)
        return "ERROR: fetch aborted";
      return `ERROR: fetch failed: ${err?.message ?? String(err)}`;
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  }
});

// src/queue-runner.ts
var log = (deps, line) => deps.onLog?.(line);
var OFFLINE_PLAN_SYSTEM = "You are planning a coding task while this machine is OFFLINE. You cannot run commands, read files, or use the internet. Based only on the task statement and your general knowledge, draft a concise to-do plan so the task can be executed later when connectivity returns. " + "Remember the plan is a starting point: whoever runs it will verify against the real repository. " + `Respond with a compact plan exactly in this shape:
` + `PLAN:
1. <step>
2. <step>
...
` + `FILES: <files you expect to create or touch>
` + "RISKS: <caveats, assumptions, or unknown repo state>";
async function draftPlanNote(route, userMessage, timeoutMs = 120000) {
  const messages = [
    { role: "system", content: OFFLINE_PLAN_SYSTEM },
    { role: "user", content: userMessage }
  ];
  const res = await route.provider.streamChat({ model: route.model, messages, max_tokens: 400, timeoutMs, temperature: 0.4 }, () => {});
  const text = (res.text ?? "").trim();
  if (!text)
    throw new Error("local model returned an empty plan");
  return text;
}
function queuedToolPolicy(deps, signal) {
  return async (name, args) => {
    if (deps.autoApproveExceptDestructive !== false && name === "bash") {
      const command = String(args.command ?? "");
      const why = bannedReason(command);
      if (why) {
        log(deps, `  [[auto-run policy]] blocked ${name}: ${why}`);
        return false;
      }
    }
    if (signal?.aborted)
      return false;
    return true;
  };
}
async function runQueuedTask(task, deps, signal) {
  const claimed = claimTask(task.id);
  if (!claimed)
    return null;
  const { config, router } = deps;
  log(deps, `▶ [${task.id}] ${task.userMessage.slice(0, 120)}${task.planNote ? " (with offline plan)" : ""}`);
  const messages = [{ role: "system", content: task.systemPrompt }];
  if (task.planNote) {
    messages.push({
      role: "user",
      content: `While offline, a draft plan was recorded for this task. Treat it as a starting point, verify it against the actual repository and codebase state with your tools, and correct anything that no longer applies.

` + task.planNote
    });
  }
  messages.push({ role: "user", content: task.userMessage });
  try {
    const route = await router.resolve(task.userMessage, "heavy");
    const chatOptions = {
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens
    };
    const result = await runAgent({
      provider: route.provider.streamChat.bind(route.provider),
      systemPrompt: task.systemPrompt,
      model: route.model,
      initialMessages: messages,
      toolCtx: { cwd: task.cwd, signal },
      signal,
      chatOptions,
      maxInputTokens: route.maxInputTokens,
      maxInputTokensPerMinute: route.maxInputTokensPerMinute
    }, {
      maxSteps: deps.maxSteps ?? 40,
      onModelText: (t) => log(deps, t),
      onToolStart: (name, args) => log(deps, `  ⚡ ${name} ${JSON.stringify(args ?? {}).slice(0, 200)}`),
      onToolEnd: (name, out) => log(deps, `  └ ${name} → ${out.split(`
`)[0].slice(0, 200)}`),
      confirmTool: queuedToolPolicy(deps, signal)
    });
    const done = markTaskDone(task.id, result.finalText || "(no final text)");
    log(deps, `✔ [${task.id}] done in ${result.steps} step(s), ${result.toolCalls} tool call(s)`);
    return done;
  } catch (err) {
    const msg = err?.message ?? String(err);
    const failed = markTaskFailed(task.id, msg);
    log(deps, `✘ [${task.id}] failed: ${msg}`);
    return failed ?? claimed;
  }
}
async function drainQueue(deps, signal) {
  let ran = 0;
  let failed = 0;
  let task;
  while ((task = nextQueued()) && !signal?.aborted) {
    const result = await runQueuedTask(task, deps, signal);
    if (!result)
      return { ran, failed };
    if (result.status === "failed")
      failed++;
    ran++;
  }
  return { ran, failed };
}

// src/ollama.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync6 } from "node:fs";
var OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
function ollamaBaseUrl(explicit) {
  const raw = explicit ?? process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_URL;
  const cleaned = raw.replace(/\/+$/, "");
  return cleaned.startsWith("http://") || cleaned.startsWith("https://") ? cleaned : `http://${cleaned}`;
}
async function ollamaIsUp(baseUrl, timeoutMs = 800) {
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}
function ollamaBinary() {
  const explicit = process.env.OLLAMA_BIN;
  if (explicit && existsSync6(explicit))
    return explicit;
  const absolutes = [
    "/data/data/com.termux/files/usr/bin/ollama",
    "/usr/local/bin/ollama",
    "/usr/bin/ollama",
    "/usr/local/go/bin/ollama"
  ];
  for (const p of absolutes)
    if (existsSync6(p))
      return p;
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    if (!dir)
      continue;
    const candidate = `${dir.replace(/\/+$/, "")}/ollama`;
    if (existsSync6(candidate))
      return candidate;
  }
  return null;
}
async function ollamaModels(baseUrl, timeoutMs = 800) {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok)
      return [];
    const data = await res.json();
    return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}
async function ensureOllamaServe(opts = {}) {
  const log2 = opts.onLog ?? (() => {});
  if (process.env.VIBECODER_NO_OLLAMA_AUTOSTART === "1") {
    return { running: false, started: false, error: "autostart disabled by env" };
  }
  const baseUrl = ollamaBaseUrl(opts.baseUrl);
  if (await ollamaIsUp(baseUrl)) {
    const models = await ollamaModels(baseUrl);
    return { running: true, started: false, models };
  }
  const bin = ollamaBinary();
  if (!bin) {
    const msg2 = `ollama not found — offline chat/planning unavailable
` + `  → install it:  https://ollama.com  (or run:  curl -fsSL https://ollama.com/install.sh | sh)
` + `  → pull the local model:  ollama pull qwen2.5:1.5b
` + "  → or go online-only: ensure connectivity reaches a provider and GROQ_API_KEY (or another key) is set";
    log2(msg2);
    return { running: false, started: false, error: msg2 };
  }
  log2(`starting ollama serve (${bin}) …`);
  try {
    const child = spawn2(bin, ["serve"], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    const msg2 = `failed to start ollama serve: ${err?.message ?? err}`;
    log2(msg2);
    return { running: false, started: false, error: msg2 };
  }
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 6000);
  while (Date.now() < deadline) {
    if (await ollamaIsUp(baseUrl, 500)) {
      const models = await ollamaModels(baseUrl);
      log2(models.length ? `ollama serve ready (${models.join(", ")})` : "ollama serve ready");
      return { running: true, started: true, models };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const msg = `ollama serve started but did not respond in time (is it stuck?)
` + `  → check it with:  ollama list
` + `  → pull the configured model:  ollama pull qwen2.5:1.5b
` + "  → or set GROQ_API_KEY so online providers stay available while ollama is down";
  log2(msg);
  return { running: false, started: true, error: msg };
}

// src/tools/termux.ts
registerTool({
  definition: {
    type: "function",
    function: {
      name: "termux_notify",
      description: "Push a notification to the Android status bar via Termux:API (termux-notification). Use at the end of long tasks so you know when they finish without watching the terminal. Takes a title and optional message. Returns the command output or a clear 'not available' note.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Notification title (short)" },
          message: { type: "string", description: "Notification body (optional, defaults to title)" }
        },
        required: ["title"]
      }
    }
  },
  async run(args, ctx) {
    const title = String(args.title ?? "").slice(0, 100);
    const message = String(args.message ?? title).slice(0, 500);
    if (!title)
      return "ERROR: title is required";
    const proc = Bun.spawn({
      cmd: [
        "termux-notification",
        "--title",
        title,
        "--content",
        message
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
      detached: true
    });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      let output = "";
      if (stdout)
        output += stdout;
      if (stderr)
        output += stderr ? (output ? `
` : "") + stderr : "";
      if (exitCode !== 0)
        output += (output ? `
` : "") + `[exit code: ${exitCode}]`;
      return output || `notification pushed: "${title}"`;
    } catch (err) {
      return `ERROR: termux-notification failed: ${err?.message ?? String(err)} (is termux-api installed? pkg install termux-api)`;
    }
  }
});

// src/tools/tailscale.ts
registerTool({
  definition: {
    type: "function",
    function: {
      name: "tailscale_status",
      description: "Check Tailscale tunnel status: whether connected, the machine's tailnet IP, peer devices, and any upstream exit node / ACL status. Returns the full `tailscale status` output (or a concise summary if the output is large). Inert when tailscale isn't installed.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "boolean",
            description: "When true, return only a short human-readable summary (connected + tailnet IP + peer count) instead of the full table."
          }
        },
        required: []
      }
    }
  },
  async run(args, ctx) {
    const wantSummary = Boolean(args.summary);
    const bin = Bun.spawn({
      cmd: ["which", "tailscale"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
      detached: true
    });
    const [whichOut, whichErr, whichExit] = await Promise.all([
      new Response(bin.stdout).text(),
      new Response(bin.stderr).text(),
      bin.exited
    ]);
    if (whichExit !== 0 || !whichOut.trim()) {
      return "ERROR: tailscale not found on PATH — install it: https://tailscale.com/download (or termux: pkg install tailscale)";
    }
    const useJson = wantSummary;
    const proc = Bun.spawn({
      cmd: useJson ? ["tailscale", "status", "--json"] : ["tailscale", "status"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
      detached: true
    });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      let output = "";
      if (stdout)
        output += stdout;
      if (stderr)
        output += stderr ? (output ? `
` : "") + stderr : "";
      if (exitCode !== 0)
        output += (output ? `
` : "") + `[exit code: ${exitCode}]`;
      if (useJson && stdout) {
        try {
          const j = JSON.parse(stdout);
          const dnsName = j.dnsName ?? "(no dnsName)";
          const magicSrc = j.magicDNSSrcIP ?? "(no magicDNSSrcIP)";
          const selfPeer = j.Self ?? null;
          const peerIps = ((selfPeer?.MagicDNSSrcIP) ? [(selfPeer.MagicDNSSrcIP ?? "").replace(/\.(\d+)$/, "") + ".local"] : []).concat(selfPeer?.TailscaleIPs ?? []).filter(Boolean);
          const peers = j.Peers ?? {};
          const peerCount = Object.keys(peers).length;
          const onlinePeers = Object.values(peers).filter((p) => p.Online === true).length;
          return [
            `tailscale: ${j.CanCarryPossibly ? "connected" : "not connected"}${j.BackendState ? ` (backend: ${j.BackendState})` : ""}`,
            `  hostname: ${dnsName}`,
            `  tailnet IP: ${peerIps.join(", ") || "(none)"}`,
            `  peers: ${peerCount} total, ${onlinePeers} online`,
            j.BackendState === "Connecting" ? "  ⚠ still connecting — give it a moment" : ""
          ].filter(Boolean).join(`
`);
        } catch {}
      }
      return output || "(no output)";
    } catch (err) {
      return `ERROR: tailscale status failed: ${err?.message ?? String(err)}`;
    }
  }
});

// src/session.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync5, readdirSync as readdirSync3, readFileSync as readFileSync5, rmSync as rmSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join7 } from "node:path";
var _root2 = null;
function root2() {
  if (_root2)
    return _root2;
  const envDir = process.env.VIBECODER_SESSION_DIR;
  _root2 = envDir || join7(homedir4(), ".vibecoder");
  mkdirSync5(_root2, { recursive: true });
  mkdirSync5(join7(_root2, "sessions"), { recursive: true });
  return _root2;
}
function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function shortHash(s) {
  let h = 0;
  for (const ch of s)
    h = (h << 5) - h + ch.codePointAt(0) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}
function resolveResumeArg(argv) {
  const idx = argv.indexOf("--resume");
  if (idx === -1)
    return { resume: false, name: null };
  const raw = argv[idx + 1];
  const name = raw && !raw.startsWith("-") ? raw : null;
  return { resume: true, name };
}
function lastFile() {
  return join7(root2(), "last.json");
}
function sessionFile(id) {
  const clean = sanitizeId(id);
  const fname = clean === id ? clean : `${clean}--${shortHash(id)}`;
  return join7(root2(), "sessions", `${fname}.json`);
}
function saveSession(s) {
  s.updatedAt = Date.now();
  if (!s.createdAt)
    s.createdAt = s.updatedAt;
  const f = sessionFile(s.id);
  writeFileSync4(f, JSON.stringify(s, null, 2));
  return f;
}
function loadSession(id) {
  if (!id)
    return null;
  const f = sessionFile(id);
  if (!existsSync7(f))
    return null;
  try {
    return JSON.parse(readFileSync5(f, "utf8"));
  } catch {
    return null;
  }
}
function deleteSession(id) {
  const f = sessionFile(id);
  if (!existsSync7(f))
    return false;
  try {
    rmSync2(f, { force: true });
    return true;
  } catch {
    return false;
  }
}
function listSessions() {
  const out = [];
  const dir = join7(root2(), "sessions");
  if (!existsSync7(dir))
    return out;
  for (const name of readdirSync3(dir)) {
    if (!name.endsWith(".json"))
      continue;
    let s = null;
    try {
      const parsed = JSON.parse(readFileSync5(join7(dir, name), "utf8"));
      if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.messages))
        s = parsed;
    } catch {}
    if (!s)
      continue;
    out.push({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      provider: s.provider,
      model: s.model,
      messageCount: s.messages.length
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
function saveLast(s) {
  writeFileSync4(lastFile(), JSON.stringify(s, null, 2));
}
function loadLast() {
  if (!existsSync7(lastFile()))
    return null;
  try {
    return JSON.parse(readFileSync5(lastFile(), "utf8"));
  } catch {
    return null;
  }
}

// src/ui/terminal.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import fs from "node:fs";
function enableMouse() {
  out("\x1B[?1000h\x1B[?1006h");
}
function disableMouse() {
  out("\x1B[?1000l\x1B[?1006l");
}
var WIDE = /[\u1100-\u115F\u2300-\u23FF\u2500-\u25FF\u2700-\u27BF\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function displayWidth(s) {
  let w = 0;
  for (const ch of s)
    w += WIDE.test(ch) ? 2 : 1;
  return w;
}
function wrapText(s, width) {
  const out = [];
  for (const raw of s.split(`
`)) {
    if (raw === "") {
      out.push("");
      continue;
    }
    let cur = "";
    let curW = 0;
    for (const ch of raw) {
      const cw = WIDE.test(ch) ? 2 : 1;
      if (curW + cw > width) {
        out.push(cur);
        cur = ch;
        curW = cw;
      } else {
        cur += ch;
        curW += cw;
      }
    }
    out.push(cur);
  }
  return out;
}
var ANSI_SGR = /\x1b\[([0-9;]*)m/g;
function sgrEncode(codes) {
  if (codes.length === 0 || codes.length === 1 && codes[0] === 0)
    return "";
  return `\x1B[${codes.join(";")}m`;
}
function sgrApply(codes, spec) {
  const parts = spec === "" ? ["0"] : spec.split(";");
  const fg = (c) => c >= 30 && c <= 37 || c >= 90 && c <= 97;
  const bg = (c) => c >= 40 && c <= 47 || c >= 100 && c <= 107;
  for (const raw of parts) {
    const c = Number(raw);
    if (Number.isNaN(c))
      continue;
    if (c === 0) {
      codes.length = 0;
      continue;
    }
    if (c === 22 || c === 23 || c === 25 || c === 27) {
      const i = codes.indexOf(c === 22 ? 1 : c === 23 ? 3 : c === 25 ? 8 : c === 27 ? 2 : -1);
      if (i !== -1)
        codes.splice(i, 1);
      continue;
    }
    if (fg(c)) {
      for (let i = codes.length - 1;i >= 0; i--)
        if (fg(codes[i]))
          codes.splice(i, 1);
      codes.push(c);
      continue;
    }
    if (bg(c)) {
      for (let i = codes.length - 1;i >= 0; i--)
        if (bg(codes[i]))
          codes.splice(i, 1);
      codes.push(c);
      continue;
    }
    codes.push(c);
  }
}
function wrapAnsi(s, width) {
  const out = [];
  for (const raw of s.split(`
`)) {
    if (raw === "") {
      out.push("");
      continue;
    }
    const chars = [];
    const pre = [];
    const stateEnc = [];
    const state = [];
    let preBuf = "";
    let m;
    ANSI_SGR.lastIndex = 0;
    let last = 0;
    const pushRun = (run) => {
      for (const ch of run) {
        chars.push(ch);
        pre.push(preBuf);
        preBuf = "";
        stateEnc.push(sgrEncode(state));
      }
    };
    while (m = ANSI_SGR.exec(raw)) {
      if (m.index > last)
        pushRun(raw.slice(last, m.index));
      sgrApply(state, m[1]);
      preBuf += m[0];
      last = m.index + m[0].length;
    }
    if (last < raw.length)
      pushRun(raw.slice(last));
    if (chars.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let w = 0;
    const flush = () => {
      if (!line)
        return;
      out.push(line);
      line = "";
      w = 0;
    };
    for (let i = 0;i < chars.length; i++) {
      const cw = WIDE.test(chars[i]) ? 2 : 1;
      const prefix = pre[i] !== "" ? pre[i] : line === "" ? stateEnc[i] : "";
      if (w + cw > width) {
        if (!line) {
          line = prefix + chars[i];
          w = cw;
          continue;
        }
        flush();
        line = (pre[i] !== "" ? pre[i] : stateEnc[i]) + chars[i];
        w = cw;
        continue;
      }
      line += prefix;
      line += chars[i];
      w += cw;
    }
    flush();
  }
  return out;
}
function out(s) {
  process.stdout.write(s.replace(/\n/g, `\r
`));
}
var ansi = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  black: "\x1B[30m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  blue: "\x1B[34m",
  magenta: "\x1B[35m",
  cyan: "\x1B[36m",
  white: "\x1B[37m",
  gray: "\x1B[90m"
};
function fg(n) {
  return `\x1B[${30 + n}m`;
}
function paint(s, color) {
  return color === undefined ? s : `${fg(color)}${s}${ansi.reset}`;
}
var ttyState = null;
function hasControllingTty() {
  if (ttyState !== null)
    return ttyState;
  try {
    const fd = fs.openSync("/dev/tty", "r+");
    fs.closeSync(fd);
    ttyState = true;
  } catch {
    ttyState = false;
  }
  return ttyState;
}
function ttyStty(args) {
  const r = spawnSync2("stty", ["-F", "/dev/tty", ...args], { encoding: "utf8" });
  return r.stdout?.trim() ?? "";
}
function getSize() {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  if (Number.isFinite(rows) && Number.isFinite(cols) && rows > 0 && cols > 0) {
    return { rows, cols };
  }
  let r = 24;
  let c = 80;
  try {
    const size = ttyStty(["size"]).split(" ");
    if (size.length >= 2 && /^\d+$/.test(size[0]) && /^\d+$/.test(size[1])) {
      r = parseInt(size[0], 10);
      c = parseInt(size[1], 10);
    }
  } catch {}
  if (!(Number.isFinite(r) && Number.isFinite(c) && r > 0 && c > 0)) {
    return { rows: 24, cols: 80 };
  }
  return { rows: r, cols: c };
}
function enableRawMode() {
  ttyStty(["raw", "-echo"]);
}
function restoreTerminal() {
  if (!hasControllingTty())
    return;
  try {
    ttyStty(["sane"]);
    ttyStty(["echo"]);
  } catch {}
}
var FINAL_BYTE = (b) => b >= 64 && b <= 126 || b === 27;
function singleKey(b) {
  switch (b) {
    case 13:
    case 10:
      return { kind: "enter" };
    case 127:
    case 8:
      return { kind: "backspace" };
    case 9:
      return { kind: "tab" };
    case 3:
      return { kind: "ctrl-c" };
    case 12:
      return { kind: "ctrl-l" };
    case 23:
      return { kind: "ctrl-w" };
    case 21:
      return { kind: "ctrl-u" };
    case 1:
      return { kind: "home" };
    case 5:
      return { kind: "end" };
    case 27:
      return { kind: "esc" };
    default: {
      if (b >= 32 && b <= 126)
        return { kind: "char", char: String.fromCharCode(b) };
      if (b >= 192 && b < 254)
        return { kind: "unknown", raw: String.fromCharCode(b) };
      return { kind: "unknown", raw: `\\x${b.toString(16).padStart(2, "0")}` };
    }
  }
}
function csiKey(bytes) {
  let final = -1;
  let idx = -1;
  for (let i = 0;i < bytes.length; i++) {
    if (FINAL_BYTE(bytes[i])) {
      final = bytes[i];
      idx = i;
      break;
    }
  }
  if (final === -1)
    return { kind: "unknown", raw: `CSI<${bytes.map((b) => b.toString(16)).join(" ")}>` };
  const paramStr = bytes.slice(0, idx).map((b) => String.fromCharCode(b)).join("").split(";").filter((p) => p !== "");
  const params = paramStr;
  const mod = params.length >= 2 ? parseInt(params[1], 10) : undefined;
  const ctrl = mod === 5 || mod === 2 ? true : false;
  if (params[0]?.startsWith("<")) {
    const btn = parseInt(params[0].slice(1), 10);
    if (btn === 64)
      return { kind: "scrollup" };
    if (btn === 65)
      return { kind: "scrolldown" };
    return { kind: "unknown", raw: params.join(";") + String.fromCharCode(final) };
  }
  if (final === 65)
    return { kind: "up" };
  if (final === 66)
    return { kind: "down" };
  if (final === 67)
    return ctrl ? { kind: "ctrl-right" } : { kind: "right" };
  if (final === 68)
    return ctrl ? { kind: "ctrl-left" } : { kind: "left" };
  if (final === 72)
    return { kind: "home" };
  if (final === 70)
    return { kind: "end" };
  if (final === 126) {
    const p = parseInt(params[0] ?? "", 10);
    if (p === 3)
      return { kind: "delete" };
    if (p === 1)
      return { kind: "home" };
    if (p === 4)
      return { kind: "end" };
    if (p === 5)
      return { kind: "pageup" };
    if (p === 6)
      return { kind: "pagedown" };
  }
  return { kind: "unknown", raw: `CSI${params.join(";")}${String.fromCharCode(final)}` };
}

class KeyParser {
  hold = [];
  feed(bytes) {
    const all = [...this.hold, ...bytes];
    const out2 = [];
    let i = 0;
    this.hold = [];
    while (i < all.length) {
      const b = all[i];
      if (b !== 27) {
        out2.push(singleKey(b));
        i++;
        continue;
      }
      const rest = all.slice(i + 1);
      if (rest.length === 0) {
        this.hold = [b];
        i = all.length;
        break;
      }
      if (rest[0] === 91) {
        let fin = -1;
        for (let j = 1;j < rest.length; j++) {
          if (FINAL_BYTE(rest[j])) {
            fin = j;
            break;
          }
        }
        if (fin === -1) {
          this.hold = all.slice(i);
          i = all.length;
          break;
        }
        out2.push(csiKey(rest.slice(1, fin + 1)));
        i += 1 + fin + 1;
      } else if (rest[0] === 79) {
        if (rest.length < 2 || !FINAL_BYTE(rest[1])) {
          this.hold = [...all.slice(i), ...rest.length >= 2 ? [] : []];
          this.hold = all.slice(i);
          i = all.length;
          break;
        }
        const c = rest[1];
        const map = {
          65: { kind: "up" },
          66: { kind: "down" },
          67: { kind: "right" },
          68: { kind: "left" },
          72: { kind: "home" },
          70: { kind: "end" }
        };
        out2.push(map[c] ?? { kind: "unknown", raw: `SS3${String.fromCharCode(c)}` });
        i += 3;
      } else {
        out2.push({ kind: "esc" });
        i += 1;
      }
    }
    return out2;
  }
  finalize() {
    if (this.hold.length === 1 && this.hold[0] === 27) {
      this.hold = [];
      return [{ kind: "esc" }];
    }
    if (this.hold.length) {
      const evs = [];
      for (const b of this.hold)
        evs.push(singleKey(b));
      this.hold = [];
      return evs;
    }
    return [];
  }
  hasPending() {
    return this.hold.length > 0;
  }
}

class KeyReader {
  parser = new KeyParser;
  pending = [];
  chunks = [];
  resolvers = [];
  closed = false;
  constructor(stream) {
    stream.on("data", (d) => {
      if (this.resolvers.length)
        this.resolvers.shift()(d);
      else
        this.chunks.push(d);
    });
    stream.on("end", () => {
      this.closed = true;
      while (this.resolvers.length)
        this.resolvers.shift()(Buffer.alloc(0));
    });
  }
  nextChunk() {
    if (this.closed)
      return Promise.resolve(Buffer.alloc(0));
    if (this.chunks.length)
      return Promise.resolve(this.chunks.shift());
    return new Promise((r) => this.resolvers.push(r));
  }
  async next() {
    for (;; ) {
      if (this.pending.length)
        return this.pending.shift();
      if (this.parser.hasPending()) {
        await new Promise((r) => setTimeout(r, 25));
        const late = this.parser.feed([]);
        if (late.length)
          this.pending.push(...late);
        const fin = this.parser.finalize();
        if (fin.length)
          this.pending.push(...fin);
        continue;
      }
      const chunk = await this.nextChunk();
      if (chunk.length === 0)
        return { kind: "unknown", raw: "<eof>" };
      const evs = this.parser.feed([...chunk]);
      if (evs.length)
        this.pending.push(...evs);
    }
  }
}

// src/ui/present/theme.ts
var theme = {
  accent: fg(36),
  violet: fg(35),
  deep: fg(34),
  success: fg(32),
  warm: fg(33),
  error: fg(31),
  muted: fg(90),
  reset: ansi.reset,
  bold: ansi.bold,
  dim: ansi.dim
};

// src/ui/tui.ts
var MAX_SCROLLBACK = 2000;
var WHEEL_STEP = 4;
var INPUT_PREFIX_COLS = 3;

class TUI {
  callbacks;
  rows;
  cols;
  reader;
  scrollback = [];
  stream = { text: "" };
  status = { text: "" };
  scrollOffset = 0;
  inputOffset = 0;
  input = "";
  cursor = 0;
  history = [];
  histIdx = -1;
  busy = false;
  approveMode = "off";
  running = true;
  keyHandler = null;
  commands = ["help", "clear", "provider", "model", "approve", "exit"];
  promptOverride = null;
  constructor(rows, cols, callbacks) {
    this.callbacks = callbacks;
    this.rows = rows;
    this.cols = cols;
    this.reader = new KeyReader(process.stdin);
  }
  start() {
    const s = getSize();
    this.rows = s.rows;
    this.cols = s.cols;
    out("\x1B[?1049h");
    out("\x1B[?25l");
    enableRawMode();
    enableMouse();
    out("\x1B[H\x1B[2J");
    this.render();
    process.stdout.on("resize", this.onWinch);
    this.loop();
  }
  onWinch = () => {
    const s = getSize();
    this.rows = s.rows;
    this.cols = s.cols;
    this.callbacks.onResize?.(this.rows, this.cols);
    this.render();
  };
  async loop() {
    while (this.running) {
      const ev = await this.reader.next();
      if (!this.running)
        break;
      if (this.keyHandler) {
        const h = this.keyHandler;
        this.keyHandler = null;
        h(ev);
        this.render();
        continue;
      }
      if (this.busy) {
        if (ev.kind === "ctrl-c")
          this.callbacks.onAbort();
        else if (ev.kind === "ctrl-l")
          this.render();
        else if (ev.kind === "pageup") {
          this.scrollBy(this.pageSize());
          this.render();
        } else if (ev.kind === "pagedown") {
          this.scrollBy(-this.pageSize());
          this.render();
        } else if (ev.kind === "scrollup") {
          this.scrollBy(WHEEL_STEP);
          this.render();
        } else if (ev.kind === "scrolldown") {
          this.scrollBy(-WHEEL_STEP);
          this.render();
        } else if (ev.kind === "enter" || ev.kind === "tab") {
          this.render();
        } else {
          this.handleIdle(ev);
          this.render();
        }
        continue;
      }
      this.handleIdle(ev);
      if (this.running)
        this.render();
    }
  }
  handleIdle(ev) {
    switch (ev.kind) {
      case "char":
        this.input = this.input.slice(0, this.cursor) + ev.char + this.input.slice(this.cursor);
        this.cursor++;
        break;
      case "enter":
        if (!this.input.trim())
          return;
        this.submit();
        break;
      case "backspace":
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor--;
        }
        break;
      case "delete":
        if (this.cursor < this.input.length) {
          this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        }
        break;
      case "left":
        if (this.cursor > 0)
          this.cursor--;
        break;
      case "ctrl-left": {
        const before = this.input.slice(0, this.cursor);
        const m = before.match(/(\w+)$/);
        if (m)
          this.cursor -= m[1].length;
        break;
      }
      case "right":
        if (this.cursor < this.input.length)
          this.cursor++;
        break;
      case "ctrl-right": {
        const after = this.input.slice(this.cursor);
        const m = after.match(/^\s*(\w+)/);
        if (m)
          this.cursor += m[0].length;
        break;
      }
      case "home":
        this.cursor = 0;
        break;
      case "end":
        this.cursor = this.input.length;
        break;
      case "ctrl-u":
        this.input = "";
        this.cursor = 0;
        break;
      case "ctrl-w": {
        const before = this.input.slice(0, this.cursor);
        const m = before.match(/(\S+)\s*$/);
        if (m)
          this.cursor -= m[1].length;
        break;
      }
      case "up":
        if (this.histIdx === -1 && this.history.length)
          this.histIdx = this.history.length;
        if (this.histIdx > 0) {
          this.histIdx--;
          this.input = this.history[this.histIdx];
          this.cursor = this.input.length;
        }
        break;
      case "down":
        if (this.histIdx !== -1) {
          this.histIdx++;
          if (this.histIdx >= this.history.length) {
            this.histIdx = -1;
            this.input = "";
          } else {
            this.input = this.history[this.histIdx];
          }
          this.cursor = this.input.length;
        }
        break;
      case "tab":
        this.complete();
        break;
      case "ctrl-c":
        if (this.input) {
          this.input = "";
          this.cursor = 0;
        } else {
          this.close();
          process.exit(0);
        }
        break;
      case "ctrl-l":
        this.render();
        break;
      case "pageup":
        this.scrollBy(this.pageSize());
        break;
      case "pagedown":
        this.scrollBy(-this.pageSize());
        break;
      case "scrollup":
        this.scrollBy(WHEEL_STEP);
        break;
      case "scrolldown":
        this.scrollBy(-WHEEL_STEP);
        break;
      case "esc":
      default:
        break;
    }
  }
  complete() {
    if (!this.input.startsWith("/"))
      return;
    const parts = this.input.split(" ");
    if (parts.length === 1) {
      const partial = this.input.slice(1);
      const matches = this.commands.filter((c) => c.startsWith(partial));
      if (matches.length === 1) {
        this.input = "/" + matches[0];
        this.cursor = this.input.length;
      } else if (matches.length > 1) {
        this.printToScrollback(paint(`  ${matches.join("  ")}`, 7), true);
      }
    }
  }
  pageSize() {
    return Math.max(1, this.rows - 4);
  }
  cursorVisPos() {
    const lines = wrapText(this.input, Math.max(8, this.cols - 1 - INPUT_PREFIX_COLS));
    let acc = 0;
    for (let li = 0;li < lines.length; li++) {
      if (this.cursor <= acc + lines[li].length) {
        return { line: li, col: displayWidth(lines[li].slice(0, this.cursor - acc)) };
      }
      acc += lines[li].length;
    }
    const last = Math.max(0, lines.length - 1);
    return { line: last, col: displayWidth(lines[last]) };
  }
  scrollBy(delta) {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
  }
  submit() {
    const line = this.input;
    this.input = "";
    this.cursor = 0;
    this.inputOffset = 0;
    this.history.push(line);
    if (this.history.length > 100)
      this.history.shift();
    this.histIdx = -1;
    this.callbacks.onSubmit(line);
  }
  printToScrollback(text, clamp) {
    this.pushStreamLines(text, clamp);
  }
  separator() {
    this.printToScrollback(ansi.dim + "─".repeat(Math.max(10, this.cols - 1)) + ansi.reset);
  }
  streamText(text, color) {
    this.stream.color = color;
    if (!text) {
      this.render();
      return;
    }
    const hasNewline = text.includes(`
`);
    this.stream.text += text;
    if (hasNewline) {
      const lines = this.stream.text.split(`
`);
      this.stream.text = lines.pop() ?? "";
      for (const l of lines)
        this.scrollback.push({ text: l, color: this.stream.color });
    }
    this.render();
  }
  endStream() {
    if (this.stream.text) {
      this.scrollback.push({ text: this.stream.text, color: this.stream.color });
      this.stream.text = "";
    }
    this.render();
  }
  setStatus(text, color) {
    this.status = { text, color };
    this.render();
  }
  pushStreamLines(text, clamp) {
    for (const l of text.split(`
`)) {
      if (clamp && this.scrollback.length > MAX_SCROLLBACK)
        break;
      this.scrollback.push({ text: l });
      if (this.scrollback.length > MAX_SCROLLBACK)
        this.scrollback.shift();
    }
    this.render();
  }
  clearScrollback() {
    this.scrollback = [];
    this.stream = { text: "" };
    this.scrollOffset = 0;
    this.render();
  }
  askConfirm(question) {
    if (this.approveMode === "off")
      return Promise.resolve("yes");
    return new Promise((resolve4) => {
      this.promptOverride = `${question}  ${ansi.bold}[y/n/a]${ansi.reset}`;
      this.render();
      this.keyHandler = (ev) => {
        if (ev.kind === "char" && (ev.char === "y" || ev.char === "Y")) {
          this.promptOverride = null;
          resolve4("yes");
        } else if (ev.kind === "char" && (ev.char === "n" || ev.char === "N")) {
          this.promptOverride = null;
          resolve4("no");
        } else if (ev.kind === "char" && (ev.char === "a" || ev.char === "A")) {
          this.promptOverride = null;
          resolve4("all");
        } else if (ev.kind === "ctrl-c") {
          this.promptOverride = null;
          resolve4("no");
        } else {
          this.render();
        }
      };
    });
  }
  render() {
    const colW = Math.max(10, this.cols - 1);
    const maxInputRows = Math.max(1, this.rows - 4);
    const inputLines = wrapText(this.input, Math.max(8, colW - INPUT_PREFIX_COLS));
    const shownInputRows = Math.min(inputLines.length, maxInputRows);
    const cpos = this.cursorVisPos();
    if (shownInputRows > 1) {
      if (cpos.line < this.inputOffset)
        this.inputOffset = cpos.line;
      if (cpos.line - this.inputOffset >= shownInputRows) {
        this.inputOffset = cpos.line - shownInputRows + 1;
      }
    } else {
      this.inputOffset = 0;
    }
    const inputTop = this.rows - shownInputRows + 1;
    const statusRow = inputTop - 1;
    const contentRows = Math.max(1, statusRow - 1);
    const rendered = [];
    for (const l of this.scrollback) {
      const segments = l.text.includes("\x1B") ? wrapAnsi(l.text, colW) : wrapText(l.text, colW);
      for (const s of segments) {
        let t = s;
        if (l.bold)
          t = ansi.bold + t;
        if (l.color !== undefined)
          t = paint(t, l.color);
        rendered.push(t);
      }
    }
    if (this.stream.text) {
      for (const s of wrapText(this.stream.text, colW)) {
        rendered.push(this.stream.color !== undefined ? paint(s, this.stream.color) : s);
      }
    }
    const total = rendered.length;
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, total - contentRows));
    const endIdx = total - this.scrollOffset;
    const startIdx = Math.max(0, endIdx - contentRows);
    const vis = rendered.slice(startIdx, endIdx);
    let output = "\x1B[H";
    if (vis.length === 0 && !this.stream.text) {
      for (let r = 0;r < contentRows; r++)
        output += `\x1B[${r + 1};1H\x1B[K`;
    } else {
      for (let r = 0;r < contentRows; r++) {
        const line = vis[r];
        output += `\x1B[${r + 1};1H`;
        output += line ? line + "\x1B[K" : "\x1B[K";
      }
    }
    let statusText = this.status.text;
    if (this.scrollOffset > 0) {
      statusText = `${statusText}  ${ansi.dim}↑${this.scrollOffset}/${total}${ansi.reset}`;
    }
    output += `\x1B[${statusRow};1H`;
    output += statusText ? paint(statusText.slice(0, colW), this.status.color) + "\x1B[K" : theme.violet + "●" + theme.reset + "  " + theme.muted + "Ready" + theme.reset + "\x1B[K";
    if (this.promptOverride) {
      output += `\x1B[${inputTop};1H`;
      output += this.promptOverride.slice(0, colW) + "\x1B[K";
      for (let r = 1;r < shownInputRows; r++)
        output += `\x1B[${inputTop + r};1H\x1B[K`;
      out(output);
      return;
    }
    for (let r = 0;r < shownInputRows; r++) {
      const line = inputLines[this.inputOffset + r] ?? "";
      if (r === 0 && !this.input.trim()) {
        const placeholder = theme.muted + "+  Ask anything..." + theme.reset;
        output += `\x1B[${inputTop + r};1H`;
        output += theme.violet + "+" + theme.reset + "  " + placeholder + "\x1B[K" + ansi.reset;
        continue;
      }
      const prefix = r === 0 ? theme.violet + "+" + theme.reset + "  " : " ".repeat(INPUT_PREFIX_COLS);
      output += `\x1B[${inputTop + r};1H`;
      output += prefix + line + "\x1B[K";
    }
    const cursorRow = inputTop + (cpos.line - this.inputOffset);
    const cursorCol = 1 + INPUT_PREFIX_COLS + cpos.col;
    output += `\x1B[${cursorRow};${Math.min(cursorCol, colW + 1)}H`;
    out(output);
  }
  close() {
    if (!this.running)
      return;
    this.running = false;
    process.stdout.removeListener("resize", this.onWinch);
    out("\x1B[?25h");
    out("\x1B[?1049l");
    disableMouse();
    restoreTerminal();
    process.stdout.write(`\r
`);
  }
}

// src/llm/model-cards.ts
var CARDS = [
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    family: "NVIDIA Nemotron 3",
    architecture: "Hybrid Mamba-Transformer Mixture-of-Experts",
    paramsTotal: "550B",
    paramsActive: "55B",
    context: 1e6,
    maxOutput: 32768,
    dataCutoff: "post-training May 2026 / pre-training Sep 2025",
    license: "OpenMDW-1.1",
    capabilities: ["text chat", "long-context agentic workflows", "reasoning/planning", "tool calling"],
    limits: ["text-only (no native image/video input)", "hosted trial API — NVIDIA NIM terms apply"]
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    alias: ["nvidia/nemotron-3-super"],
    family: "NVIDIA Nemotron 3",
    architecture: "LatentMoE — Mamba-2 + MoE + attention hybrid, Multi-Token Prediction",
    paramsTotal: "120B",
    paramsActive: "12B",
    context: 1e6,
    maxOutput: 32768,
    dataCutoff: "not published",
    license: "OpenMDW-1.1",
    capabilities: ["text chat", "agentic workloads", "tool calling"],
    limits: ["text-only", "hosted trial API — NVIDIA NIM terms apply"]
  },
  {
    id: "qwen3.8-27b",
    alias: ["qwen/qwen3.8-27b"],
    family: "Qwen (Alibaba)",
    architecture: "unknown (GROQ-hosted; Qwen3 family)",
    paramsTotal: "~27B (per model id)",
    context: 128000,
    maxOutput: 4000,
    dataCutoff: "not published for this hosting",
    license: "Apache-2.0 (Qwen3)",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only", "GROQ free tier caps input at 7000 tokens/min"]
  },
  {
    id: "openai/gpt-oss-120b",
    family: "OpenAI GPT-OSS",
    architecture: "Mixture-of-Experts decoder",
    paramsTotal: "120B",
    paramsActive: "5B",
    context: 128000,
    maxOutput: 32768,
    dataCutoff: "not published",
    license: "Apache-2.0 + OpenAI additional terms",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only"]
  },
  {
    id: "openai/gpt-oss-20b",
    family: "OpenAI GPT-OSS",
    architecture: "Mixture-of-Experts decoder",
    paramsTotal: "21B",
    paramsActive: "3.6B",
    context: 128000,
    maxOutput: 32768,
    dataCutoff: "not published",
    license: "Apache-2.0 + OpenAI additional terms",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only"]
  },
  {
    id: "groq/compound",
    family: "GROQ compiler/routing model",
    architecture: "unknown (provider-composite)",
    paramsTotal: "not published",
    context: 128000,
    maxOutput: 4000,
    dataCutoff: "not published",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only", "GROQ free tier caps input at 7000 tokens/min"]
  },
  {
    id: "qwen2.5:1.5b",
    family: "Qwen2.5 (Alibaba)",
    architecture: "Dense Transformer decoder",
    paramsTotal: "1.5B",
    context: 131072,
    maxOutput: 8192,
    dataCutoff: "knowledge cutoff Sep 2024 (per Qwen2.5)",
    license: "Apache-2.0",
    capabilities: ["text chat", "tool calling"],
    limits: ["text-only", "small model — keep tasks simple", "local Ollama — depends on host hardware"]
  },
  {
    id: "llama3.1",
    family: "Meta Llama 3.1",
    architecture: "Dense Transformer decoder",
    paramsTotal: "varies by tag (default tag resolves to a specific size)",
    context: 131072,
    maxOutput: 8192,
    dataCutoff: "Dec 2023 (base pretraining)",
    license: "Llama 3.1 Community License",
    capabilities: ["text chat"],
    limits: ["text-only", "local Ollama — depends on host hardware"]
  },
  {
    id: "gpt-4o",
    family: "OpenAI",
    architecture: "Transformer (proprietary)",
    paramsTotal: "not published",
    context: 128000,
    maxOutput: 16384,
    dataCutoff: "Oct 2023",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling", "image input (API-dependent)"],
    limits: ["paid API — not free tier"]
  },
  {
    id: "gpt-4o-mini",
    family: "OpenAI",
    architecture: "Transformer (proprietary)",
    paramsTotal: "not published",
    context: 128000,
    maxOutput: 16384,
    dataCutoff: "Oct 2023",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling"],
    limits: ["paid API — not free tier"]
  },
  {
    id: "claude-sonnet-4-5",
    family: "Anthropic Claude family",
    architecture: "proprietary (Anthropic)",
    paramsTotal: "not published",
    context: 200000,
    maxOutput: 8192,
    dataCutoff: "not published",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling"],
    limits: ["paid API — not free tier", "hosted by Anthropic"]
  },
  {
    id: "claude-3-5-haiku-latest",
    family: "Anthropic Claude family",
    architecture: "proprietary (Anthropic)",
    paramsTotal: "not published",
    context: 200000,
    maxOutput: 8192,
    dataCutoff: "Apr 2024 (initial 3.5 Haiku)",
    license: "proprietary (hosted)",
    capabilities: ["text chat", "tool calling"],
    limits: ["paid API — not free tier", "hosted by Anthropic"]
  }
];
function findModelCard(model) {
  const m = model.toLowerCase();
  return CARDS.find((c) => c.id.toLowerCase() === m || (c.alias ?? []).some((a) => a.toLowerCase() === m)) ?? CARDS.find((c) => c.id.toLowerCase().includes(m) || m.includes(c.id.toLowerCase())) ?? null;
}

// src/self-knowledge.ts
var identity = { provider: "", model: "" };
function setRuntimeIdentity(provider, model) {
  identity = { provider, model };
}
var SELF_EDIT_PROTOCOL = `
SELF-EDIT PROTOCOL (appended by the runtime; config edits cannot remove it):
- Editing your live config (config.json — the file /about reports; in user installs this is ~/.vibecoder/config.json, or .env in a repo install) is a SELF-EDIT. Each one is written to SELF_EDITS.jsonl, an append-only audit ledger.
- Self-edits are STAGED: they only go live after the human runs /reload-config. Never claim a config change is live.
- If you intend to change config.json, tell the human what changed and that it needs /reload-config (approve) or /undo-self-edits (revert) before continuing.
- Never modify or delete SELF_EDITS.jsonl, and never remove the /reload-config or /undo-self-edits commands — such edits are blocked or audited and revertible via git (repo) or backups (user install).
- For source-code/style changes, edit files as normal; those are versioned by git.`;
function toolListLines() {
  return listTools().map((t) => `  - ${t.function.name}: ${t.function.description}`);
}
function cardLines(model) {
  const c = findModelCard(model);
  if (!c)
    return ["  - no model card on file for this id — details not published"];
  const a = c.paramsActive ? ` (${c.paramsActive} active)` : "";
  return [
    `  - family: ${c.family}`,
    `  - architecture: ${c.architecture}`,
    `  - parameters: ${c.paramsTotal}${a}`,
    `  - context: ${c.context.toLocaleString("en")} tokens · max output: ${c.maxOutput}`,
    `  - data cutoff: ${c.dataCutoff}`,
    `  - license: ${c.license}`,
    `  - capabilities: ${c.capabilities.join(", ")}`,
    `  - limits: ${c.limits.join("; ")}`
  ];
}
async function buildSelfReport() {
  const model = identity.model || "unknown";
  const provider = identity.provider || "unknown";
  const pkg = readPackageJson();
  const version = pkg?.version || "dev";
  const { config: cfg, paths } = await loadConfigInfo();
  const cfgPath = paths.effectiveFile;
  const lines = [
    `
${"\x1B[1m"}${"\x1B[32m"}vibecoder — self-knowledge report${"\x1B[0m"}`,
    ``,
    `Identity`,
    `  - I am Vibecoder, an autonomous AI coding agent running inside a terminal.`,
    `  - build: v${version} (runtime ${process.versions.bun ? "bun " + process.versions.bun : "node " + process.version})`,
    `  - provider: ${provider} · model: ${model}`,
    ``,
    `Model card`,
    ...cardLines(model),
    ``,
    `Routing`,
    ...routingReportLines(cfg),
    ``,
    `Runtime configuration`,
    `  - config file: ${cfgPath}${paths.merged ? " (built-in defaults + your ~/.vibecoder/config.json)" : ""}`,
    `  - systemPrompt: ${cfg?.systemPrompt ? "custom (from config)" : "not set explicitly"}`,
    `  - temperature: ${cfg?.temperature ?? "unset"} · maxTokens: ${cfg?.maxTokens ?? "unset"}`,
    `  - maxInputTokens: ${cfg?.maxInputTokens ?? "unset"} · maxInputTokensPerMinute: ${cfg?.maxInputTokensPerMinute ?? "unset"}`,
    ``,
    `Tools available to me (${listTools().length})`,
    ...toolListLines(),
    ``,
    `Self-edit state`,
    `  - audit ledger: ${ledgerPath()} (append-only, protected)`,
    ...ledgerSummary(3).length ? ledgerSummary(3) : ["  - no self-edits recorded"]
  ];
  return lines.join(`
`);
}
function routingReportLines(cfg) {
  const r = cfg?.routing;
  if (!r)
    return ["  - not configured — single model is used for everything"];
  const strategyNote = r.strategy === "keyword" ? "ambiguous → chat (keyword only)" : "ambiguous → asked to the cheap model";
  return [
    `  - auto-router: chat ${r.chatProvider}/${r.chatModel}  ·  heavy ${r.heavyProvider}/${r.heavyModel}`,
    `  - strategy: ${r.strategy} (${strategyNote})`,
    `  - the identity above reflects the model used for the last turn`
  ];
}
async function buildSelfToolReport() {
  const model = identity.model || "unknown";
  const provider = identity.provider || "unknown";
  const cfg = await loadConfig().catch(() => null);
  const c = findModelCard(model);
  const r = cfg?.routing;
  return [
    "I am Vibecoder, a terminal coding agent. I do not have a body or a life outside this conversation.",
    `provider=${provider} model=${model}`,
    c ? `model card: ${c.family} · ${c.architecture} · ${c.paramsTotal}${c.paramsActive ? " (" + c.paramsActive + " active)" : ""} · context ${c.context} · max output ${c.maxOutput} · data cutoff ${c.dataCutoff} · license ${c.license}` : "model card: not on file",
    `capabilities: ${(c ? c.capabilities : ["text chat", "tool calling"]).join(", ")}`,
    `boundaries: ${(c ? c.limits : ["no facts beyond what these tools show", "text-only"]).join("; ")}`,
    `routing: ${r ? `auto (chat ${r.chatProvider}/${r.chatModel} ↔ heavy ${r.heavyProvider}/${r.heavyModel}, strategy ${r.strategy}) · last turn used ${provider}/${model}` : "single model for everything"}`,
    `tools: ${listTools().map((t) => t.function.name).join(", ")}`,
    `config: temperature=${cfg?.temperature ?? "unset"} maxInputTokens=${cfg?.maxInputTokens ?? "unset"} maxInputTokensPerMinute=${cfg?.maxInputTokensPerMinute ?? "unset"} systemPrompt=${cfg?.systemPrompt ? "custom" : "default"}`,
    `self-edits are staged + audited in SELF_EDITS.jsonl; they go live only after the human runs /reload-config`
  ].join(`
`);
}
registerTool({
  definition: {
    type: "function",
    function: {
      name: "self_about",
      description: "Report who/what you are: your model, provider, capabilities, boundaries, tools, and runtime configuration. Use when the user asks 'who are you', 'what model are you', or 'what can you do'.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  async run() {
    return buildSelfToolReport();
  }
});

// src/ui/repl.ts
import { createInterface as createInterface2 } from "node:readline";

// src/env.ts
import { existsSync as existsSync8, readFileSync as readFileSync6 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { dirname as dirname5, join as join8 } from "node:path";
var loaded = new Set;
function envLine(line) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m)
    return null;
  const key = m[1];
  if (!key)
    return null;
  let value = m[2];
  value = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  return [key, value];
}
function loadDotEnv() {
  if (process.env.VIBECODER_NO_DOTENV === "1")
    return;
  const candidates = [
    join8(packageRoot(), ".env"),
    join8(dirname5(packageRoot()), ".env"),
    join8(homedir5(), ".vibecoder", ".env")
  ];
  for (const file of candidates) {
    if (loaded.has(file))
      continue;
    loaded.add(file);
    if (!existsSync8(file))
      continue;
    const text = readFileSync6(file, "utf8");
    for (const raw of text.split(`
`)) {
      if (!raw.trim() || raw.trim().startsWith("#"))
        continue;
      const kv = envLine(raw);
      if (!kv)
        continue;
      const [key, value] = kv;
      if (!(key in process.env))
        process.env[key] = value;
    }
  }
}

// src/doctor.ts
import { existsSync as existsSync9 } from "node:fs";
function maskKey(v) {
  if (!v)
    return "not set";
  if (v.length <= 8)
    return "set (" + "*".repeat(v.length) + ")";
  return `set (${v.slice(0, 4)}…${v.slice(-4)})`;
}
async function probeReachable(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500 ? "reachable" : `unreachable (HTTP ${res.status})`;
  } catch {
    return "unreachable";
  }
}
async function runDoctor() {
  const out2 = [];
  const say = (s = "") => out2.push(s);
  const pkg = readPackageJson();
  const version = pkg?.version ?? "dev";
  const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`;
  const isTermux = existsSync9("/data/data/com.termux") || process.env.ANDROID_DATA !== undefined || process.env.EXTERNAL_STORAGE !== undefined;
  say("vibecoder doctor");
  say(`  version:   ${version}`);
  say(`  runtime:   ${runtime} (${process.platform}/${process.arch})${isTermux ? " · Android (Termux)" : ""}`);
  say(`  install:   ${installMode()} mode`);
  let cfg;
  let paths;
  try {
    ({ config: cfg, paths } = await loadConfigInfo());
  } catch (err) {
    out2.push("");
    out2.push(`  config:    ERROR — ${err?.message ?? String(err)}`);
    out2.push("             run: vibecoder setup");
    out2.push("");
    process.stdout.write(out2.join(`
`) + `
`);
    return 1;
  }
  out2.push("");
  say("config");
  say(`  built-in defaults: ${paths.builtin ?? "not found"}`);
  say(`  your overrides:    ${paths.userFile ?? "(none — creating one is optional; see 'vibecoder setup')"}`);
  say(`  live config file:  ${paths.effectiveFile}${paths.merged ? "  (defaults + your overrides)" : ""}`);
  const active = createProvider(cfg, cfg.provider);
  say(`  default:           ${active.name}/${active.model}`);
  if (cfg.routing) {
    say(`  router:            chat ${cfg.routing.chatProvider}/${cfg.routing.chatModel}  ·  heavy ${cfg.routing.heavyProvider}/${cfg.routing.heavyModel}${cfg.routing.offlineProvider ? `  ·  offline ${cfg.routing.offlineProvider}/${cfg.routing.offlineModel ?? cfg.routing.chatModel}` : ""}`);
  }
  out2.push("");
  say("providers");
  for (const name of Object.keys(cfg.providers ?? {})) {
    const p = cfg.providers[name];
    const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    say(`  ${name}`);
    say(`    type:      ${p.type} · baseURL: ${p.baseURL}`);
    say(`    api key:   ${p.apiKeyEnv ? `${p.apiKeyEnv} → ${maskKey(key)}` : "(none — local)"}`);
    say(`    models:    ${(p.models ?? []).join(", ")}`);
  }
  out2.push("");
  say("ollama (local, no cost)");
  const bin = ollamaBinary();
  const up = ollamaIsUp(ollamaBaseUrl());
  say(`  binary:    ${bin ? "found (" + bin + ")" : "not installed — offline chat unavailable"}`);
  if (await up) {
    const models = await ollamaModels(ollamaBaseUrl());
    say(`  server:    running on ${ollamaBaseUrl()}`);
    say(`  models:    ${models.length ? models.join(", ") : "(none pulled yet — try: ollama pull qwen2.5:1.5b)"}`);
  } else {
    say(`  server:    not running`);
  }
  const probeUrl = (() => {
    try {
      const c = cfg.connectivity;
      return c?.probeUrl ?? "https://api.groq.com/openai/v1/models";
    } catch {
      return "https://api.groq.com/openai/v1/models";
    }
  })();
  out2.push("");
  say("connectivity");
  say(`  probe:   ${probeUrl} → ${await probeReachable(probeUrl)}`);
  say(`  note:    offline is fine — chat falls back to your local ollama, and heavy tasks queue until online`);
  out2.push("");
  say("data");
  say(`  sessions:  ~/.vibecoder/sessions/  (saved conversations)`);
  say(`  queue:     ~/.vibecoder/queue.json (offline task queue)`);
  say(`  ledger:    ${ledgerPath()}`);
  say(`  user env:  ~/.vibecoder/.env      (optional API keys, e.g. GROQ_API_KEY=...)`);
  const userCfgExists = existsSync9(userConfigFile());
  const keysPresent = Object.keys(cfg.providers ?? {}).map((n) => cfg.providers[n].apiKeyEnv).filter(Boolean).some((k) => process.env[k]);
  out2.push("");
  say("next steps");
  if (!userCfgExists)
    say("  - customize:   vibecoder setup   (generates ~/.vibecoder/config.json)");
  if (!keysPresent)
    say("  - free online:  get a free GROQ_API_KEY (console.groq.com) and add it to ~/.vibecoder/.env");
  say('  - run it:      vibecoder        (or: vibecoder --prompt "your task")');
  process.stdout.write(out2.join(`
`) + `
`);
  return 0;
}

// src/setup.ts
import { createInterface } from "node:readline/promises";
import { stdin as stdinInput, stdout as stdoutOutput } from "node:process";
import { appendFileSync as appendFileSync2, existsSync as existsSync10, mkdirSync as mkdirSync6 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join9 } from "node:path";
var LOCAL_MODEL = "qwen2.5:1.5b";
async function prompt(question, fallback, interactive) {
  if (!interactive)
    return fallback;
  const rl = createInterface({ input: stdinInput, output: stdoutOutput });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}
async function confirm(question, fallback, interactive) {
  const suffix = fallback ? " [Y/n] " : " [y/N] ";
  const answer = await prompt(question + suffix, fallback ? "y" : "n", interactive);
  return /^y(es)?$/i.test(answer);
}
async function runSetup(argv) {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const interactive = hasControllingTty() && !yes;
  const line = (s = "") => process.stdout.write(s + `
`);
  const pkg = readPackageJson();
  line(`vibecoder setup — make vibecoder yours (free, no limitations)`);
  line(`  runtime: ${process.versions.bun ? "bun " + process.versions.bun : "node " + process.version} · package v${pkg?.version ?? "dev"}`);
  line();
  const builtinPath = resolvePackageFile("config.json");
  const builtin = builtinPath ? loadJsonFile(builtinPath) : null;
  if (existsSync10(userConfigFile())) {
    line(`An existing customization file exists: ${userConfigFile()}`);
    if (!await confirm("Overwrite it? (n keeps your current config)", false, interactive)) {
      line("OK — leaving your config untouched. Run `vibecoder doctor` to inspect it.");
      return 0;
    }
  }
  line("Local mode (free, offline-capable): Ollama runs models on YOUR machine.");
  const useOllama = await confirm("Use a local Ollama model as the default?", true, interactive);
  const model = LOCAL_MODEL;
  if (useOllama) {
    const bin = ollamaBinary();
    if (!bin) {
      line("  note: ollama is not installed yet.");
      line(`        install:  curl -fsSL https://ollama.com/install.sh | sh`);
      line(`        then pull the default model:  ollama pull ${model}`);
    } else {
      const up = await ollamaIsUp(ollamaBaseUrl());
      if (!up)
        line(`  note: ollama is installed but not running — vibecoder will start it automatically.`);
      else {
        const models = await ollamaModels(ollamaBaseUrl());
        line(`  server running, local models: ${models.length ? models.join(", ") : "(none — run: ollama pull " + model + ")"}`);
      }
    }
  } else {
    line("  using cloud providers only — set an API key below (or later in ~/.vibecoder/.env).");
  }
  line();
  line("Free cloud options (no payment): a GROQ key unlocks fast online chat; an");
  line("NVIDIA NIM key unlocks the big reasoning model. Both are free tiers.");
  const groqKey = await prompt("GROQ API key (enter or leave empty to skip): ", "", interactive);
  const nvidiaKey = await prompt("NVIDIA API key (enter or leave empty to skip): ", "", interactive);
  const overrides = {};
  if (useOllama) {
    overrides.provider = "ollama";
    overrides.model = model;
  }
  const base = builtin ?? {};
  const cfg = deepMerge(base, overrides);
  if (useOllama) {
    const routing = cfg.routing ? { ...cfg.routing, offlineProvider: "ollama", offlineModel: model } : { chatProvider: "ollama", chatModel: model, heavyProvider: "ollama", heavyModel: model, strategy: "hybrid", offlineProvider: "ollama", offlineModel: model };
    cfg.routing = routing;
  }
  const written = writeUserConfig(cfg);
  if (groqKey || nvidiaKey) {
    const envFile = join9(homedir6(), ".vibecoder", ".env");
    mkdirSync6(join9(homedir6(), ".vibecoder"), { recursive: true });
    if (groqKey)
      appendFileSync2(envFile, `GROQ_API_KEY=${groqKey}
`);
    if (nvidiaKey)
      appendFileSync2(envFile, `NVIDIA_API_KEY=${nvidiaKey}
`);
    line(`  keys written to ${envFile} (chmod 600 recommended).`);
  }
  line();
  line("Done. Your customization file:");
  line(`  ${written}`);
  line();
  line("Next:");
  line(`  vibecoder doctor                  # verify install + providers`);
  line(`  vibecoder                         # start the interactive agent`);
  line(`  vibecoder --prompt "your task"     # one-shot run`);
  if (useOllama && !await ollamaIsUp(ollamaBaseUrl()))
    line(`  ollama pull ${model}               # make sure the local model is downloaded`);
  line();
  return 0;
}

// src/ui/repl.ts
var colors = {
  dim: "\x1B[2m",
  green: "\x1B[32m",
  cyan: "\x1B[36m",
  yellow: "\x1B[33m",
  magenta: "\x1B[35m",
  red: "\x1B[31m",
  gray: "\x1B[90m",
  reset: "\x1B[0m",
  bold: "\x1B[1m"
};
var messages = [];
var systemPrompt = "";
var providerStream;
var llmModel = "";
var providerName = "";
var cwd = process.cwd();
var activeAbort = null;
var chatTemperature;
var chatMaxTokens;
var maxSteps = 40;
var maxInputTokens;
var maxInputTokensPerMinute;
var sessionId = "";
var rootConfig = null;
var router = null;
var routerMode = "auto";
var taskActive = false;
var connectivityPoller = null;
var online = false;
var nowDraining = false;
var tuiRef = null;
function limitsFor(cfg) {
  return {
    maxInputTokens: cfg.maxInputTokens ?? (cfg.provider === "groq" ? 5000 : undefined),
    maxInputTokensPerMinute: cfg.maxInputTokensPerMinute ?? (cfg.provider === "groq" ? 6500 : undefined)
  };
}
function shortId(provider, model) {
  return model.startsWith(provider + "/") ? model.slice(provider.length + 1) : model;
}
function routeLabel() {
  if (!router)
    return "";
  const { chat, heavy } = router.names();
  const c = router.chatIdentity();
  const h = router.heavyIdentity();
  if (chat === heavy)
    return `router ${routerMode} · ${chat}/${shortId(chat, c.model)}`;
  return `router ${routerMode} · chat ${chat}/${shortId(chat, c.model)} ↔ heavy ${heavy}/${shortId(heavy, h.model)}`;
}
function currentSession() {
  return {
    id: sessionId || `session-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`,
    title: sessionTitleFromMessages(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: providerName,
    model: llmModel,
    cwd,
    systemPrompt,
    messages,
    routerMode,
    messageCount: messages.length
  };
}
function sessionTitleFromMessages() {
  const firstUser = messages.find((m) => m.role === "user");
  const base = firstUser?.content?.trim() ?? "(empty conversation)";
  return base.length > 46 ? base.slice(0, 46) + "…" : base;
}
function persistLast() {
  try {
    saveLast(currentSession());
  } catch {}
}
function applySession(s) {
  if (!s || !Array.isArray(s.messages))
    return false;
  messages = s.messages.filter((m) => m && typeof m.role === "string");
  sessionId = s.id;
  taskActive = false;
  if (s.routerMode)
    routerMode = s.routerMode;
  if (s.systemPrompt)
    systemPrompt = s.systemPrompt;
  if (s.cwd)
    cwd = s.cwd;
  if (s.provider && rootConfig) {
    try {
      const r = createProvider(rootConfig, s.provider);
      providerName = r.name;
      llmModel = s.model || r.model;
      providerStream = r.provider.streamChat.bind(r.provider);
      router?.setChat(providerName, llmModel);
    } catch {}
  }
  return true;
}
function banner(_provider, _model, _dir) {
  return [];
}
async function init() {
  const config = await loadConfig();
  rootConfig = config;
  setQueueFileOverride(config.queue?.file);
  const resolved = createProvider(config);
  providerName = resolved.name;
  llmModel = resolved.model;
  systemPrompt = (config.systemPrompt ?? "You are Vibecoder.") + SELF_EDIT_PROTOCOL;
  setRuntimeIdentity(providerName, llmModel);
  chatTemperature = config.temperature;
  chatMaxTokens = config.maxTokens;
  const limits = limitsFor(config);
  maxInputTokens = limits.maxInputTokens;
  maxInputTokensPerMinute = limits.maxInputTokensPerMinute;
  providerStream = resolved.provider.streamChat.bind(resolved.provider);
  router = new ModelRouter(config, limits);
  if (router.offlineIdentity()) {
    const oll = await ensureOllamaServe({
      readyTimeoutMs: 6000,
      onLog: (line) => process.stdout.write(`${colors.dim}${line}${colors.reset}
`)
    });
    if (oll && !oll.running && !(oll.error ?? "").includes("autostart disabled")) {
      process.stdout.write(`${colors.dim}note: offline chat needs a local model (ollama pull qwen2.5:1.5b); meanwhile set GROQ_API_KEY so online routes keep working.${colors.reset}
`);
    }
  }
  const probeCfg = config.connectivity ?? {};
  const probeUrl = probeCfg.probeUrl ?? "https://api.groq.com/openai/v1/models";
  const pollMs = probeCfg.pollMs ?? 15000;
  const timeoutMs = probeCfg.timeoutMs ?? 8000;
  connectivityPoller = createConnectivityPoller({ probeUrl, timeoutMs, pollMs }, (now) => {
    online = now;
    if (tuiRef) {
      const rl = routeLabel();
      tuiRef.setStatus(`${onlineStatus()}${rl ? rl + " · " : ""}approve ${tuiRef.approveMode === "on" ? "on" : "off"}${taskActive ? " · task in progress" : ""} · PgUp/PgDn scroll`, 8);
    }
    if (online)
      inAppDrain();
  });
  await connectivityPoller.checkNow();
  online = connectivityPoller.online;
  const pIdx = process.argv.indexOf("--provider");
  if (pIdx !== -1 && process.argv[pIdx + 1]) {
    const r = createProvider(config, process.argv[pIdx + 1]);
    providerName = r.name;
    providerStream = r.provider.streamChat.bind(r.provider);
    const mIdx = process.argv.indexOf("--model");
    if (mIdx !== -1 && process.argv[mIdx + 1])
      llmModel = process.argv[mIdx + 1];
    else
      llmModel = r.model;
    router?.setChat(providerName, llmModel);
  }
  setRuntimeIdentity(providerName, llmModel);
  const dirArg = process.argv.indexOf("--cwd");
  if (dirArg !== -1 && process.argv[dirArg + 1]) {
    cwd = resolve2(process.argv[dirArg + 1], { cwd: process.cwd() });
  }
  const stepsIdx = process.argv.indexOf("--max-steps");
  if (stepsIdx !== -1 && process.argv[stepsIdx + 1]) {
    const n = parseInt(process.argv[stepsIdx + 1], 10);
    if (Number.isFinite(n) && n > 0)
      maxSteps = n;
  }
}
function onlineStatus() {
  if (online)
    return "";
  const off = router?.offlineIdentity();
  return off ? `offline (${off.provider}/${off.model}) · ` : "offline · ";
}
async function queueOfflineTask(userInput, tui) {
  if (!router || !rootConfig)
    return;
  const offRoute = router.resolveOffline(userInput);
  let planNote;
  try {
    planNote = await draftPlanNote(offRoute, userInput, 120000);
  } catch {}
  const task = enqueueTask({
    userMessage: userInput,
    cwd,
    sessionId: sessionId || `session-${Date.now().toString(36)}`,
    systemPrompt,
    planNote
  });
  const print = (s) => {
    if (tui)
      tui.printToScrollback(s);
    else
      process.stdout.write(s + `
`);
  };
  print(`${colors.green}✓ queued${colors.reset} ${colors.dim}${task.id}${colors.reset} — will run automatically when connectivity returns`);
  if (planNote)
    print(`${colors.dim}${planNote.slice(0, 600)}${colors.reset}`);
  else
    print(`${colors.dim}(offline plan draft unavailable — the task is still queued)`);
  persistLast();
}
async function inAppDrain() {
  if (nowDraining || !router || !rootConfig)
    return;
  nowDraining = true;
  try {
    const cfg = rootConfig.queue ?? {};
    const deps = {
      config: rootConfig,
      router,
      maxSteps,
      autoApproveExceptDestructive: cfg.autoApproveExceptDestructive ?? true,
      onLog: (line) => tuiRef?.printToScrollback(line)
    };
    const { ran, failed } = await drainQueue(deps);
    if (tuiRef && ran)
      tuiRef.printToScrollback(`${colors.green}[queue] drained ${ran} task(s)${failed ? `, ${failed} failed` : ""}${colors.reset}`);
  } finally {
    nowDraining = false;
  }
}
function brief(args) {
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}
async function handleCommand(line, tui) {
  const print = (s) => {
    if (tui)
      tui.printToScrollback(s);
    else
      console.log(s);
  };
  const setStatus = () => {
    if (tui) {
      const rl = routeLabel();
      tui.setStatus(`${onlineStatus()}${rl ? `provider ${providerName} · model ${llmModel} · ${rl}` : `provider ${providerName} · model ${llmModel}`}`, 8);
    }
  };
  if (["exit", "quit", "/exit", "/quit"].includes(line.trim())) {
    if (tui)
      tui.close();
    process.exit(0);
    return true;
  }
  if (line.trim() === "/help" || line.trim() === "help") {
    print(`
${colors.bold}Commands${colors.reset}`);
    print(`  ${colors.green}/provider <name>${colors.reset}  switch provider (groq, ollama, openai, anthropic…)`);
    print(`  ${colors.green}/model <id>${colors.reset}       switch model`);
    print(`  ${colors.green}/route [auto|chat|heavy]${colors.reset} ${colors.dim}model routing: auto-classify, or force chat/heavy model${colors.reset}`);
    print(`  ${colors.green}/approve [on|off]${colors.reset} ${colors.dim}toggle tool approval prompts (default off = no limits)${colors.reset}`);
    print(`  ${colors.green}/save [name]${colors.reset}      save this conversation`);
    print(`  ${colors.green}/resume [name]${colors.reset}    resume a saved conversation (or the last one)`);
    print(`  ${colors.green}/list${colors.reset}             list saved conversations`);
    print(`  ${colors.green}/delete <name>${colors.reset}    delete a saved conversation`);
    print(`  ${colors.green}/about${colors.reset}             self-knowledge report (model, config, tools)`);
    print(`  ${colors.green}/reload-config${colors.reset}     approve staged config edits — make them live`);
    print(`  ${colors.green}/review-self-edits${colors.reset} show audit ledger + pending config diff`);
    print(`  ${colors.green}/undo-self-edits${colors.reset}   reset config.json to last approved state (git)`);
    print(`  ${colors.green}/new${colors.reset}              start a fresh conversation (keeps provider/model)`);
    print(`  ${colors.green}/clear${colors.reset}            clear conversation + screen`);
    print(`  ${colors.green}/queue${colors.reset}            list queued offline tasks (auto-run when online)`);
    print(`  ${colors.green}/run-now${colors.reset}          drain the task queue now`);
    print(`  ${colors.green}/help${colors.reset}             this help`);
    print(`  ${colors.dim}PageUp/PageDown${colors.reset}       scroll back through the conversation`);
    print(`  ${colors.green}ctrl-c${colors.reset}            interrupt running task · clear input · exit
`);
    return true;
  }
  if (line.startsWith("/save")) {
    const arg = line.slice(5).trim().replace(/^\/+/, "");
    try {
      const s = currentSession();
      if (arg)
        s.id = arg;
      sessionId = s.id;
      const f = saveSession(s);
      persistLast();
      print(`${colors.green}saved${colors.reset} ${colors.dim}${f}${colors.reset}`);
    } catch (err) {
      print(`${colors.red}save failed: ${err?.message ?? String(err)}${colors.reset}`);
    }
    return true;
  }
  if (line.startsWith("/resume")) {
    const arg = line.slice(7).trim();
    let resumed = null;
    if (arg) {
      resumed = loadSession(arg);
    } else {
      resumed = loadLast();
    }
    if (!resumed) {
      print(`${colors.red}no previous conversation${arg ? ` named "${arg}"` : ""} found — use /save to keep one, or /list to browse${colors.reset}`);
    } else if (!applySession(resumed)) {
      print(`${colors.red}could not load the saved conversation${colors.reset}`);
    } else {
      setStatus();
      print(`${colors.green}resumed "${resumed.id}"${colors.reset} ${colors.dim}· ${resumed.messages.length} messages · ${resumed.provider}/${resumed.model}${colors.reset}`);
      print(`  ${colors.dim}${resumed.title}${colors.reset}`);
    }
    return true;
  }
  if (line.trim() === "/list") {
    const sessions = listSessions();
    if (!sessions.length) {
      print(`${colors.dim}no saved conversations yet — use /save${colors.reset}`);
      return true;
    }
    print(`
${colors.bold}Saved conversations${colors.reset}`);
    for (const s of sessions) {
      const when = new Date(s.updatedAt).toLocaleString();
      const tag = s.id === sessionId ? colors.green + "•" + colors.reset + " " : "  ";
      print(`  ${tag}${colors.green}${s.id}${colors.reset} ${colors.dim}${s.messageCount} msgs · ${s.provider}/${s.model} · ${when}${colors.reset}`);
      print(`      ${colors.dim}${s.title}${colors.reset}`);
    }
    return true;
  }
  if (line.startsWith("/delete")) {
    const arg = line.slice(7).trim();
    if (!arg) {
      print(`${colors.red}usage: /delete <name>${colors.reset}`);
      return true;
    }
    if (!deleteSession(arg))
      print(`${colors.red}no saved conversation named "${arg}"${colors.reset}`);
    else
      print(`${colors.green}deleted ${arg}${colors.reset}`);
    return true;
  }
  if (line.trim() === "/new") {
    messages = [];
    sessionId = "";
    taskActive = false;
    const config = await loadConfig();
    if (config.systemPrompt)
      systemPrompt = config.systemPrompt + SELF_EDIT_PROTOCOL;
    tui?.clearScrollback();
    if (tui) {
      const rl = routeLabel();
      tui.setStatus(`${onlineStatus()}${rl ? `provider ${providerName} · model ${llmModel} · ${rl}` : `provider ${providerName} · model ${llmModel}`}`, 8);
    }
    print(`${colors.dim}fresh conversation started${colors.reset}`);
    return true;
  }
  if (line.startsWith("/model ")) {
    llmModel = line.slice(7).trim();
    if (!llmModel)
      return true;
    router?.setChat(providerName, llmModel);
    taskActive = false;
    setRuntimeIdentity(providerName, llmModel);
    setStatus();
    print(`${colors.dim}model set to ${llmModel}${colors.reset}`);
    return true;
  }
  if (line.startsWith("/provider ")) {
    const config = await loadConfig();
    const r = createProvider(config, line.slice(10).trim());
    providerName = r.name;
    llmModel = r.model;
    providerStream = r.provider.streamChat.bind(r.provider);
    router?.setChat(providerName, llmModel);
    taskActive = false;
    setRuntimeIdentity(providerName, llmModel);
    setStatus();
    print(`${colors.dim}provider set to ${providerName}, model ${llmModel}${colors.reset}`);
    return true;
  }
  if (line.startsWith("/route")) {
    const arg = line.slice(6).trim().toLowerCase();
    if (!arg) {
      print(`${colors.dim}mode: ${routerMode} · ${routeLabel() || `provider ${providerName}/${llmModel}`}${colors.reset}`);
      return true;
    }
    if (arg === "auto" || arg === "chat" || arg === "heavy") {
      routerMode = arg;
      taskActive = false;
      setStatus();
      print(`${colors.dim}router mode: ${routerMode}  (chat = ${routeLabel()})${colors.reset}`);
    } else {
      print(`${colors.red}usage: /route [auto|chat|heavy]${colors.reset}`);
    }
    return true;
  }
  if (line.startsWith("/approve")) {
    const arg = line.slice(8).trim().toLowerCase();
    if (tui) {
      if (arg === "on")
        tui.approveMode = "on";
      else if (arg === "off")
        tui.approveMode = "off";
      else
        tui.approveMode = tui.approveMode === "on" ? "off" : "on";
      setStatus();
      print(`${colors.dim}tool approval: ${tui.approveMode === "on" ? "on (you approve each tool call)" : "off (agents act freely)"}${colors.reset}`);
    }
    return true;
  }
  if (line.trim() === "/about") {
    print(await buildSelfReport());
    const staged = selfFileDiffStat();
    print(staged ? `
  pending config diff (not yet live):
${staged}` : `
  ${colors.dim}pending config diff: none${colors.reset}`);
    if (staged)
      print(`  ${colors.dim}→ run /reload-config to approve and make live, or /undo-self-edits to revert${colors.reset}`);
    return true;
  }
  if (line.startsWith("/reload-config")) {
    const cfg = await loadConfig().catch(() => null);
    if (!cfg) {
      print(`${colors.red}config.json is not valid JSON right now — fix it first.${colors.reset}`);
      return true;
    }
    systemPrompt = (cfg.systemPrompt ?? "You are Vibecoder.") + SELF_EDIT_PROTOCOL;
    chatTemperature = cfg.temperature;
    chatMaxTokens = cfg.maxTokens;
    const limits = limitsFor(cfg);
    maxInputTokens = limits.maxInputTokens;
    maxInputTokensPerMinute = limits.maxInputTokensPerMinute;
    rootConfig = cfg;
    router = new ModelRouter(cfg, limits);
    appendLedger({ tool: "/reload-config", file: "config.json", beforeSha: "", afterSha: "", note: "staged config edits approved and applied by human" });
    setStatus();
    print(`${colors.green}approved & applied${colors.reset} — config is now live (${cfg.model ?? "model from config"}).${colors.dim} Consider ${colors.reset}${colors.green}git add config.json && git commit${colors.reset}${colors.dim} to mark this as the new approved baseline.${colors.reset}`);
    return true;
  }
  if (line.startsWith("/undo-self-edits")) {
    const res = restoreSelfFiles();
    if (res.ok) {
      appendLedger({ tool: "/undo-self-edits", file: "config.json", beforeSha: "", afterSha: "", note: "config.json reset to last approved (git HEAD) state by human" });
      const cfg = await loadConfig().catch(() => null);
      if (cfg) {
        systemPrompt = (cfg.systemPrompt ?? "You are Vibecoder.") + SELF_EDIT_PROTOCOL;
        rootConfig = cfg;
        const limits = limitsFor(cfg);
        maxInputTokens = limits.maxInputTokens;
        maxInputTokensPerMinute = limits.maxInputTokensPerMinute;
        router = new ModelRouter(cfg, limits);
      }
      print(`${colors.green}config.json reset to the last approved state.${colors.reset}${res.out ? ` (${res.out})` : ""}`);
      print(`  ${colors.dim}run /reload-config to reload the restored values.${colors.reset}`);
    } else {
      print(`${colors.red}reset failed:${colors.reset} ${res.out || "git restore errored"}`);
    }
    return true;
  }
  if (line.trim() === "/review-self-edits") {
    print(`
${colors.bold}Self-edit audit ledger${colors.reset}${ledgerSummary(10).length ? "" : ` ${colors.dim}(empty)${colors.reset}`}`);
    for (const l of ledgerSummary(10))
      print(l);
    const staged = selfFileDiffStat();
    print(`
${colors.bold}Pending config changes (staged, not live)${colors.reset}:${staged ? `
` + staged : ` ${colors.dim}none${colors.reset}`}`);
    if (staged)
      print(`  ${colors.dim}/reload-config to approve · /undo-self-edits to revert${colors.reset}`);
    return true;
  }
  if (line.trim() === "/clear") {
    messages = [];
    taskActive = false;
    tui?.clearScrollback();
    if (tui) {
      const rl = routeLabel();
      tui.setStatus(`${onlineStatus()}${rl ? `provider ${providerName} · model ${llmModel} · ${rl}` : `provider ${providerName} · model ${llmModel}`}`, 8);
    }
    return true;
  }
  if (line.trim() === "/queue") {
    const tasks = listTasks();
    if (!tasks.length) {
      print(`${colors.dim}task queue is empty — offline tasks will be queued here automatically${colors.reset}`);
      return true;
    }
    print(`
${colors.bold}Task queue (${tasks.length})${colors.reset}${online ? "" : `${colors.dim} — offline; will drain when online${colors.reset}`}`);
    for (const t of tasks) {
      const when = new Date(t.createdAt).toLocaleTimeString();
      const badge = t.status === "done" ? colors.green + "done" : t.status === "failed" ? colors.red + "failed" : t.status === "running" ? colors.yellow + "running" : colors.cyan + "queued";
      print(`  ${colors.gray}${t.id}${colors.reset} ${badge}${colors.reset} ${colors.dim}${when} · ${String(t.userMessage).slice(0, 70)}${colors.reset}`);
    }
    return true;
  }
  if (line.trim() === "/run-now" || line.trim() === "/drain") {
    if (!router || !rootConfig) {
      print(`${colors.red}router not initialised — try again in a moment${colors.reset}`);
      return true;
    }
    print(online ? `${colors.dim}draining queued tasks… (destination: router heavy model)${colors.reset}` : `${colors.dim}terminal is offline — /run-now attempts the queue anyway; it will retry when online${colors.reset}`);
    await inAppDrain();
    print(`${colors.green}drain complete${colors.reset}`);
    return true;
  }
  if (line.startsWith("/")) {
    print(`${colors.red}unknown command: ${line} — try /help${colors.reset}`);
    return true;
  }
  return false;
}
async function runPrompt(userInput, tui) {
  messages.push({ role: "user", content: userInput });
  let turnProvider = providerStream;
  let turnModel = llmModel;
  let turnMaxInput = maxInputTokens;
  let turnMaxInputPerMinute = maxInputTokensPerMinute;
  let heavyRoute = false;
  let routeNote = "";
  if (router) {
    if (!online) {
      const c = classifyMessage(userInput);
      if (c === "heavy") {
        await queueOfflineTask(userInput, tui);
        messages.pop();
        return;
      }
      const off = router.resolveOffline(userInput);
      turnProvider = off.provider.streamChat.bind(off.provider);
      turnModel = off.model;
      turnMaxInput = off.maxInputTokens;
      turnMaxInputPerMinute = off.maxInputTokensPerMinute;
      setRuntimeIdentity(off.providerName, off.model);
      routeNote = `→ offline local: ${off.providerName}/${off.model}`;
    } else {
      const route = await router.resolve(userInput, routerMode, taskActive);
      turnProvider = route.provider.streamChat.bind(route.provider);
      turnModel = route.model;
      turnMaxInput = route.maxInputTokens;
      turnMaxInputPerMinute = route.maxInputTokensPerMinute;
      heavyRoute = router.isHeavy(route);
      setRuntimeIdentity(route.providerName, route.model);
      routeNote = `→ ${heavyRoute ? "heavy" : "chat"}: ${route.providerName}/${route.model}`;
    }
  }
  if (!tui) {
    process.stdout.write(`${colors.cyan}● ${turnModel}${colors.reset}${routeNote ? ` ${colors.dim}${routeNote}${colors.reset}` : ""}
`);
  } else {
    tui.printToScrollback("");
    tui.separator();
    tui.printToScrollback(`${colors.bold}${colors.cyan}❯ ${userInput}${colors.reset}`);
    if (routeNote)
      tui.printToScrollback(`${colors.dim}${routeNote}${colors.reset}`);
    tui.busy = true;
    tui.setStatus(`router ${routerMode}${taskActive ? " · task" : ""}${heavyRoute ? " · heavy" : ""} — thinking…  (ctrl-c to interrupt)`, 8);
  }
  let aborted = false;
  const ac = new AbortController;
  activeAbort = ac;
  const startedAt = Date.now();
  let streaming = false;
  let reasoningShown = false;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spin = 0;
  const statusTimer = tui ? setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const label = streaming ? "thinking" : "connecting";
    tui?.setStatus(`${spinnerFrames[spin++ % spinnerFrames.length]} ${label}… ${secs}s (ctrl-c to interrupt)`, 8);
  }, 120) : null;
  try {
    const result = await runAgent({
      provider: turnProvider,
      systemPrompt,
      model: turnModel,
      initialMessages: messages,
      toolCtx: { cwd, signal: ac.signal },
      signal: ac.signal,
      chatOptions: {
        temperature: chatTemperature,
        max_tokens: chatMaxTokens
      },
      maxInputTokens: turnMaxInput,
      maxInputTokensPerMinute: turnMaxInputPerMinute
    }, {
      maxSteps,
      onModelText: (t) => {
        streaming = true;
        if (tui)
          tui.streamText(t, 7);
        else
          process.stdout.write(t);
      },
      onReasoning: (t) => {
        if (tui) {
          if (!reasoningShown) {
            tui.printToScrollback(`${colors.dim}[reasoning]${colors.reset}`);
            reasoningShown = true;
          }
          tui.streamText(t, 8);
        }
      },
      onToolStart: (name, args) => {
        streaming = true;
        if (tui)
          tui.printToScrollback(`${colors.yellow}⚡ ${name}${colors.reset} ${colors.gray}${brief(args)}${colors.reset}`);
        else
          process.stdout.write(`
${colors.yellow}⚡ ${name}${colors.reset} ${colors.gray}${brief(args)}${colors.reset}
`);
      },
      onToolEnd: (name, resultText) => {
        const firstLine = resultText.split(`
`)[0].slice(0, 90);
        if (tui)
          tui.printToScrollback(`${colors.gray}  └ ${firstLine}${resultText.includes(`
`) ? "…" : ""}${colors.reset}`);
        else
          process.stdout.write(`${colors.gray}[${name} → ${firstLine}${resultText.includes(`
`) ? "…" : ""}]${colors.reset}
`);
      },
      onTrimmed: (trimmed, truncatedChars) => {
        const note = `(trimmed ${trimmed} message(s)${truncatedChars ? `, truncated ${truncatedChars} chars` : ""} to fit the input token budget)`;
        if (tui)
          tui.printToScrollback(`${colors.dim}${note}${colors.reset}`);
        else
          process.stdout.write(`${colors.dim}${note}${colors.reset}
`);
      },
      confirmTool: async (name, args) => {
        if (!tui || tui.approveMode === "off")
          return true;
        const ans = await tui.askConfirm(`${colors.yellow}${name}${colors.reset} ${colors.gray}${brief(args)}${colors.reset}`);
        if (ans === "all")
          tui.approveMode = "off";
        return ans !== "no";
      },
      onDone: (res) => {
        if (tui)
          tui.endStream();
        aborted = res.finishReason === "aborted";
      }
    });
    messages.push({ role: "assistant", content: result.finalText });
    if (result.aborted)
      taskActive = false;
    else
      taskActive = heavyRoute && result.toolCalls > 0;
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (tui)
      tui.printToScrollback(`${colors.red}${msg}${colors.reset}`);
    else
      process.stdout.write(`
${colors.red}${msg}${colors.reset}
`);
  } finally {
    if (statusTimer)
      clearInterval(statusTimer);
    activeAbort = null;
    reasoningShown = false;
    persistLast();
    if (tui) {
      tui.busy = false;
      const rl = routeLabel();
      tui.setStatus(`${onlineStatus()}${rl ? rl + " · " : ""}approve ${tui.approveMode === "on" ? "on" : "off"}${taskActive ? " · task in progress" : ""} · PgUp/PgDn scroll`, 8);
    } else {
      process.stdout.write(`
`);
    }
  }
}
function mainTUI() {
  const tui = new TUI(24, 80, {
    onSubmit: (line) => {
      (async () => {
        try {
          if (await handleCommand(line, tui))
            return;
          if (tui.busy)
            return;
          await runPrompt(line, tui);
        } catch (err) {
          tui.printToScrollback(`${colors.red}${err?.message ?? String(err)}${colors.reset}`);
        }
      })();
    },
    onAbort: () => {
      activeAbort?.abort();
      tui.setStatus("interrupting…", 3);
    }
  });
  process.on("exit", () => tui.close());
  process.on("SIGINT", () => {
    persistLast();
    tui.close();
    process.exit(0);
  });
  tui.start();
  const rl0 = routeLabel();
  tui.setStatus(`${onlineStatus()}${rl0 ? `provider ${providerName} · model ${llmModel} · ${rl0} · approve off · PgUp/PgDn scroll` : `provider ${providerName} · model ${llmModel} · approve off · PgUp/PgDn scroll`}`, 0);
}
function mainLine() {
  console.log(banner(providerName, llmModel, cwd).join(`
`));
}
function mainLineInteractive() {
  console.log(banner(providerName, llmModel, cwd).join(`
`));
  const rl = createInterface2({
    input: process.stdin,
    output: process.stdout
  });
  const ask = () => rl.question(`${colors.green}❯${colors.reset} `, async (input) => {
    const line = input.trim();
    if (!line)
      return ask();
    try {
      if (await handleCommand(line))
        return ask();
      await runPrompt(line);
    } catch (err) {
      console.error(`${colors.red}${err?.message ?? String(err)}${colors.reset}`);
    }
    ask();
  });
  rl.on("close", () => {
    process.stdout.write(`
`);
    process.exit(0);
  });
  ask();
}
function printUsage() {
  const v = readPackageJson()?.version ?? "dev";
  console.log(`vibecoder v${v} — a free, custom AI coding agent for your terminal`);
  console.log("");
  console.log("Usage:");
  console.log("  vibecoder                    interactive TUI REPL");
  console.log('  vibecoder "task message"      one-shot prompt');
  console.log('  vibecoder --prompt "task"     one-shot prompt (same as above)');
  console.log("  vibecoder setup              generate ~/.vibecoder/config.json (customize it!)");
  console.log("  vibecoder setup --yes        same, without prompts");
  console.log("  vibecoder doctor             check install, config, providers, connectivity");
  console.log("  vibecoder queue [start|status|stop]   run the queue daemon (vibecoder-queue)");
  console.log("");
  console.log("Options:");
  console.log("  --provider <name>   pick provider (groq, ollama, openai, anthropic, nvidia…)");
  console.log("  --model <id>        pick model");
  console.log("  --resume [name]     resume last (or named) conversation");
  console.log("  --max-steps <n>     cap the agent loop (default 40)");
  console.log("  --cwd <path>        work from another directory");
  console.log("  --version, -v       print version");
  console.log("  --help, -h          this help");
  console.log("");
  console.log("Environment:");
  console.log("  VIBECODER_CONFIG     exact config file to use (skips merge); otherwise ~/.vibecoder/config.json overrides defaults");
  console.log("  VIBECODER_SESSION_DIR  where sessions/ and queue.json live (default ~/.vibecoder)");
  console.log("  VIBECODER_NO_DOTENV=1   disable .env loading");
  console.log("  GROQ_API_KEY / NVIDIA_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY  (in ~/.vibecoder/.env or your shell)");
}
async function main() {
  loadDotEnv();
  const first = process.argv[2];
  if (first === "setup") {
    process.exitCode = await runSetup(process.argv);
    return;
  }
  if (first === "doctor") {
    process.exitCode = await runDoctor();
    return;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    console.log(readPackageJson()?.version ?? "dev");
    return;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    printUsage();
    return;
  }
  await init();
  const resume = resolveResumeArg(process.argv);
  if (resume.resume) {
    const resumed = resume.name ? loadSession(resume.name) : loadLast();
    if (resumed) {
      if (!applySession(resumed)) {
        console.log(`could not load the saved session${resumed.id ? ` "${resumed.id}"` : ""}`);
      }
    } else {
      console.log(`no previous conversation${resume.name ? ` named "${resume.name}"` : ""} found — use /save to keep one, or /list to browse`);
    }
  }
  const promptIdx = process.argv.indexOf("--prompt");
  let prompt2 = promptIdx !== -1 ? process.argv[promptIdx + 1] : undefined;
  if (prompt2 === undefined && process.argv.length === 3 && process.argv[2] && !process.argv[2].startsWith("-")) {
    prompt2 = process.argv[2];
  }
  if (prompt2) {
    mainLine();
    await runPrompt(prompt2);
    return;
  }
  if (hasControllingTty()) {
    mainTUI();
  } else {
    mainLineInteractive();
  }
}
main().catch((err) => {
  process.stderr.write(`${colors.red}${err?.message ?? err}${colors.reset}
`);
  process.exit(1);
});
