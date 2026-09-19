#!/usr/bin/env node
// src/daemon.ts
import { mkdirSync as mkdirSync5, readFileSync as readFileSync6, writeFileSync as writeFileSync4, unlinkSync } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join9 } from "node:path";

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

// src/env.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";
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
    join3(packageRoot(), ".env"),
    join3(dirname2(packageRoot()), ".env"),
    join3(homedir2(), ".vibecoder", ".env")
  ];
  for (const file of candidates) {
    if (loaded.has(file))
      continue;
    loaded.add(file);
    if (!existsSync3(file))
      continue;
    const text = readFileSync3(file, "utf8");
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
    const kept = lastIdx.map((j) => cloneMessage(nonSystem[j]));
    return { messages: [...system.map(cloneMessage), ...kept], trimmed: messages.length - (system.length + kept.length), truncatedChars: 0 };
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
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync4, rmSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4, dirname as dirname3 } from "node:path";
var _root = null;
var FILE_OVERRIDE = null;
function expandHome(p) {
  if (p === "~")
    return homedir3();
  if (p.startsWith("~/"))
    return join4(homedir3(), p.slice(2));
  return p;
}
function root() {
  if (_root)
    return _root;
  const envDir = process.env.VIBECODER_SESSION_DIR;
  _root = envDir || join4(homedir3(), ".vibecoder");
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
  return join4(root(), "queue.json");
}
function read() {
  const f = queueFile();
  if (!existsSync4(f))
    return [];
  try {
    const arr = JSON.parse(readFileSync4(f, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function write(tasks) {
  mkdirSync2(dirname3(queueFile()), { recursive: true });
  writeFileSync2(queueFile(), JSON.stringify(tasks, null, 2));
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
      if (Date.now() - statSync(lp).mtimeMs > LOCK_STALE_MS && existsSync4(lp)) {
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
function resetStale() {
  return withLock(() => {
    const tasks = read();
    let n = 0;
    for (const t of tasks) {
      if (t.status === "running") {
        if (!t.runnerPid || !processExists(t.runnerPid)) {
          n++;
          t.status = "queued";
          t.runnerPid = undefined;
        }
      }
      if (t.status === "queued" && t.runnerPid)
        t.runnerPid = undefined;
    }
    write(tasks);
    return n;
  });
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
function killProcessTree(child, signal = "SIGKILL") {
  if (child.pid === undefined || child.pid <= 0)
    return;
  killProcessGroup(child, signal);
  try {
    child.kill(signal);
  } catch {}
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
    let forceTimer = null;
    const settle = (exitCode) => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      if (forceTimer)
        clearTimeout(forceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (spawnError) {
        stderr = (stderr ? stderr + `
` : "") + `spawn error: ${spawnError}`;
      }
      resolvePromise({ stdout, stderr, exitCode, timedOut, aborted });
    };
    const forceSettle = (exitCode) => {
      if (settled)
        return;
      killProcessTree(child);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {}
      settle(exitCode);
    };
    const armForceSettle = () => {
      if (forceTimer)
        return;
      forceTimer = setTimeout(() => forceSettle(-1), 150);
    };
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        opts.onTimeout?.();
        killProcessTree(child);
        armForceSettle();
      }, opts.timeoutMs);
    }
    const onAbort = () => {
      if (settled)
        return;
      aborted = true;
      killProcessTree(child);
      armForceSettle();
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
  { re: /(?:^|[;&|\n])\s*(rm|rmdir|mv|dd|mkfs(\.[a-z0-9]+)?|truncate|fdisk|parted)\s/, why: "file/directory-destroying command" },
  { re: /(?:^|[;&|\n])\s*git\s+(reset\s+--hard|clean\s+-(f|d|fd)|checkout\s+\S+\s+--?[^;]*|push\b|remote\s+set-url|branch\s+-D|stash\s+drop|rebase\b|merge\b|cherry-pick\b)/, why: "git state mutation" },
  { re: /(?:^|[;&|\n])\s*(npm|pnpm|yarn|bun|deno)\s+(i|install|add|update|remove|uninstall|upgrade)\b/, why: "package manager install/remove" },
  { re: /(?:^|[;&|\n])\s*(pip|pip3)\s+(install|uninstall|download)\b/, why: "pip install/remove" },
  { re: /(?:^|[;&|\n])\s*(apt|apt-get|dnf|yum|zypper|brew)\s+(install|remove|uninstall|purge|update|upgrade)\b/, why: "system package manager" },
  { re: /(?:^|[;&|\n])\s*(cargo|go)\s+(install|add)\b/, why: "language package manager" },
  { re: /\b(kill|pkill|killall|systemctl|service|reboot|shutdown|halt|poweroff|init|swapoff|mkswap)\b/, why: "process/system control" },
  { re: /(?:^|[;&|\n])\s*sudo\b/, why: "sudo" },
  { re: /\s(>|>>|2>)\s*/, why: "output redirection writes a file" },
  { re: /\btee\s+-?a?\s+/, why: "tee writes to a file" }
];
function bannedReason(command) {
  const c = command.trim();
  for (const { re, why } of PLAN_MODE_BANNED) {
    if (re.test(c))
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
    if (res.timedOut)
      output += (output ? `
` : "") + `[killed: timed out after ${timeout}ms]`;
    if (res.aborted)
      output += (output ? `
` : "") + "[killed: interrupted]";
    if (!res.timedOut && !res.aborted && res.exitCode !== 0) {
      output += (output ? `
` : "") + `[exit code: ${res.exitCode}]`;
    }
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
import { dirname as dirname5, join as join6 } from "node:path";
import { mkdirSync as mkdirSync4, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";

// src/self-edit.ts
import { createHash } from "node:crypto";
import { copyFileSync, existsSync as existsSync5, mkdirSync as mkdirSync3, readFileSync as readFileSync5, appendFileSync, readdirSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join5, resolve as resolve3, dirname as dirname4 } from "node:path";
var LEDGER_NAME = "SELF_EDITS.jsonl";
function repoRoot() {
  const env = process.env.VIBECODER_REPO_ROOT;
  if (env)
    return resolve3(env);
  return dirname4(packageRoot());
}
function installMode() {
  if (process.env.VIBECODER_REPO_ROOT)
    return "repo";
  const root = dirname4(packageRoot());
  if (existsSync5(join5(root, ".git")) || existsSync5(join5(packageRoot(), ".git")))
    return "repo";
  return "user";
}
function userDataRoot() {
  if (process.env.VIBECODER_SESSION_DIR)
    return process.env.VIBECODER_SESSION_DIR;
  return join5(homedir4(), ".vibecoder");
}
function repoConfigFile() {
  return resolvePackageFile("config.json");
}
function liveConfigFile() {
  const repo = reposWhere();
  if (repo && installMode() === "repo")
    return repo.config;
  const repoCfg = repoConfigFile();
  if (installMode() === "repo" && repoCfg && !existsSync5(userConfigFile()))
    return repoCfg;
  return userConfigFile();
}
function ledgerPath() {
  return installMode() === "repo" ? join5(repoRoot(), LEDGER_NAME) : join5(userDataRoot(), LEDGER_NAME);
}
function backupsDir() {
  return join5(userDataRoot(), "backups");
}
function isSameFile(a, b) {
  return resolve3(a) === resolve3(b);
}
function reposWhere() {
  if (process.env.VIBECODER_REPO_ROOT) {
    const root = resolve3(process.env.VIBECODER_REPO_ROOT);
    return { root, config: join5(root, "config.json"), env: join5(root, ".env") };
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
function appendLedger(entry) {
  try {
    const full = { ts: new Date().toISOString(), ...entry };
    mkdirSync3(dirname4(ledgerPath()), { recursive: true });
    appendFileSync(ledgerPath(), JSON.stringify(full) + `
`, "utf8");
    return true;
  } catch {
    return false;
  }
}
function snapshotConfig(content) {
  const dir = backupsDir();
  mkdirSync3(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join5(dir, `config-${ts}.json`);
  writeFileSync3(file, content, "utf8");
  return file;
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
          const st = statSync2(join6(p, e.name));
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
    mkdirSync4(dirname5(p), { recursive: true });
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

// src/tools/search.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join as join8 } from "node:path";

// src/tools/glob.ts
import { opendir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join as join7 } from "node:path";
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
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          const childAbs = join7(dir, e.name);
          if (e.isDirectory()) {
            await recurse(remaining, childAbs, childRel);
          } else if (!onlyFiles || e.isFile()) {
            push(childRel);
          }
        }
        return;
      }
      await recurse(remaining.slice(1), dir, rel);
      let entries;
      try {
        entries = await opendir(dir);
      } catch {
        return;
      }
      for await (const e of entries) {
        if (truncated || scanned >= maxScanned)
          break;
        if (e.isDirectory() && !exclusions.has(e.name)) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          await recurse(remaining, join7(dir, e.name), childRel);
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
          await recurse(remaining.slice(1), join7(dir, e.name), childRel);
        }
      }
    }
  };
  await recurse(segs, cwd, "");
  return out;
}

// src/tools/search.ts
var MAX_RESULTS = 50;
var MAX_SCANNED = 1e5;
var MAX_FILE_BYTES = 4 * 1024 * 1024;
var MAX_LINE_CHARS = 2000;
var EXCLUDED_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);
var DEFAULT_TIMEOUT_MS = 60000;
function globToRegExp(glob) {
  let rx = "^";
  for (let i = 0;i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        rx += ".*";
        i++;
      } else {
        rx += "[^/]*";
      }
    } else if (c === "?") {
      rx += "[^/]";
    } else {
      rx += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(rx + "$");
}
async function scanDir(root2, pattern, includeRx, limit, deadline) {
  const hits = [];
  let scanned = 0;
  let timedOut = false;
  const walk = async (dir, rel) => {
    if (hits.length >= limit || timedOut)
      return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const e of entries) {
      if (hits.length >= limit || timedOut)
        return;
      if (EXCLUDED_DIRS.has(e.name))
        continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const full = join8(dir, e.name);
      if (e.isDirectory()) {
        if (Date.now() >= deadline) {
          timedOut = true;
          return;
        }
        await walk(full, childRel);
      } else if (e.isFile()) {
        if (++scanned > MAX_SCANNED)
          return;
        if (!includeRx.test(e.name) && !includeRx.test(childRel))
          continue;
        let size;
        try {
          size = (await stat(full)).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES)
          continue;
        let content;
        try {
          content = await readFile(full, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\x00"))
          continue;
        const lines = content.split(`
`);
        for (let i = 0;i < lines.length && hits.length < limit; i++) {
          if (pattern.test(lines[i])) {
            let text = lines[i];
            if (text.length > MAX_LINE_CHARS)
              text = text.slice(0, MAX_LINE_CHARS) + "…";
            hits.push({ path: childRel, line: i + 1, text });
          }
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          return;
        }
      }
    }
  };
  await walk(root2, "");
  return { hits, timedOut };
}
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
    const patternText = String(args.pattern ?? "");
    const dir = args.path ? String(args.path) : ctx.cwd;
    const include = args.include ? String(args.include) : "*";
    const timeout = Math.max(0, Number(args.timeout ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    let pattern;
    try {
      pattern = new RegExp(patternText);
    } catch (err) {
      return `ERROR: invalid search pattern: ${err?.message ?? String(err)}`;
    }
    let includeRx;
    try {
      includeRx = globToRegExp(include);
    } catch (err) {
      return `ERROR: invalid include pattern: ${err?.message ?? String(err)}`;
    }
    let rootInfo;
    try {
      rootInfo = await stat(dir);
    } catch (err) {
      return `ERROR: cannot search directory "${dir}": ${err?.message ?? String(err)}`;
    }
    if (!rootInfo.isDirectory())
      return `ERROR: not a directory: ${dir}`;
    const { hits, timedOut } = await scanDir(dir, pattern, includeRx, MAX_RESULTS + 1, Date.now() + timeout);
    const shown = hits.slice(0, MAX_RESULTS);
    let output = shown.map((h) => `${h.path}:${h.line}:${h.text}`).join(`
`);
    if (timedOut)
      output += (output ? `
` : "") + `[killed: timed out after ${timeout} ms]`;
    if (shown.length === 0) {
      output = output.trim() || "(no matches)";
    } else if (hits.length > shown.length) {
      output += `
...(${hits.length - shown.length} more)`;
    }
    return output;
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

// src/daemon.ts
function expandHome2(p) {
  if (p === "~")
    return homedir5();
  if (p.startsWith("~/"))
    return join9(homedir5(), p.slice(2));
  return p;
}
var PID_FILE = join9(homedir5(), ".vibecoder", "queue-daemon.pid");
function readPid() {
  try {
    const s = readFileSync6(PID_FILE, "utf8").trim();
    const pid = Number(s);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
function writePid() {
  mkdirSync5(join9(homedir5(), ".vibecoder"), { recursive: true });
  writeFileSync4(PID_FILE, String(process.pid));
}
function removePid() {
  try {
    unlinkSync(PID_FILE);
  } catch {}
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function lock() {
  const existing = readPid();
  if (existing !== null && existing !== process.pid && alive(existing)) {
    console.error(`[vibecoder-queue] daemon already running (pid ${existing}); exiting.`);
    return false;
  }
  writePid();
  return true;
}
function logger(logPath) {
  const ts = () => new Date().toISOString();
  if (!logPath)
    return (line) => console.log(`[${ts()}] ${line}`);
  mkdirSync5(logPath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  return (line) => {
    const text = `[${ts()}] ${line}
`;
    writeFileSync4(logPath, text, { flag: "a" });
  };
}
async function main() {
  loadDotEnv();
  if (!lock()) {
    process.exit(1);
  }
  process.on("exit", removePid);
  process.on("SIGINT", () => {
    removePid();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    removePid();
    process.exit(0);
  });
  const cfg = await loadConfig().catch((e) => {
    console.error(`[queue] config load failed: ${e.message}`);
    process.exit(1);
  });
  const rawLogFile = cfg.queue?.daemonLog;
  const logFile = rawLogFile ? expandHome2(rawLogFile) : join9(homedir5(), ".vibecoder", "queue-daemon.log");
  setQueueFileOverride(cfg.queue?.file);
  const onLog = logger(logFile);
  const onLogToConsole = (line) => {
    console.log(line);
    onLog(line);
  };
  const reset = resetStale();
  if (reset)
    onLog(`[queue] reset ${reset} stale running task(s) from previous crash`);
  const limits = {
    maxInputTokens: cfg.maxInputTokens ?? (cfg.provider === "groq" ? 5000 : undefined),
    maxInputTokensPerMinute: cfg.maxInputTokensPerMinute ?? (cfg.provider === "groq" ? 6500 : undefined)
  };
  const router = new ModelRouter(cfg, limits);
  const runnerDeps = {
    config: cfg,
    router,
    onLog: onLogToConsole,
    autoApproveExceptDestructive: cfg.queue?.autoApproveExceptDestructive ?? true
  };
  const probeCfg = cfg.connectivity ?? {};
  const probeUrl = probeCfg.probeUrl ?? "https://api.groq.com/openai/v1/models";
  const pollMs = probeCfg.pollMs ?? 15000;
  const timeoutMs = probeCfg.timeoutMs ?? 8000;
  onLog(`[queue] daemon started — probing ${probeUrl} every ${pollMs}ms`);
  let inFlight = false;
  const tryDrain = async (poller) => {
    if (inFlight)
      return;
    inFlight = true;
    try {
      if (poller.online) {
        const { ran, failed } = await drainQueue(runnerDeps);
        if (ran)
          onLog(`[queue] drained ${ran} task(s) (${failed} failed)`);
      }
    } finally {
      inFlight = false;
    }
  };
  const poller = createConnectivityPoller({ probeUrl, timeoutMs, pollMs }, (online) => {
    onLog(online ? `[queue] online — attempting queue drain` : `[queue] offline — tasks will queue`);
    tryDrain(poller);
  });
  await poller.start();
  await tryDrain(poller);
  await new Promise((res) => {
    setInterval(() => {}, 1e4);
    process.on("SIGTERM", () => res(undefined));
  });
}
function cmdStatus() {
  const pid = readPid();
  if (pid === null || !alive(pid)) {
    console.log("[queue] daemon not running");
    process.exit(0);
  }
  let queued = 0;
  try {
    const tasks = JSON.parse(readFileSync6(queueFile(), "utf8"));
    queued = tasks.filter((t) => t.status === "queued" || t.status === "running").length;
  } catch {}
  console.log(`[queue] daemon running (pid ${pid}) — ${queued} queued/running task(s)`);
  process.exit(0);
}
function cmdStop() {
  const pid = readPid();
  if (pid === null || !alive(pid)) {
    console.log("[queue] daemon not running");
    process.exit(0);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  console.log(`[queue] stop signal sent to pid ${pid}`);
  process.exit(0);
}
var cmd = process.argv[2] ?? "start";
if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log("1.0.0");
  process.exit(0);
}
if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(`vibecoder-queue — task-queue daemon (part of vibecoder).
` + `Usage: vibecoder-queue [start|status|stop]   (start is default)
` + `Also:  vibecoder-queue --version | --help
`);
  process.exit(0);
}
if (cmd !== "start" && cmd !== "status" && cmd !== "stop") {
  console.error(`[vibecoder-queue] unknown argument: ${cmd} (try 'status' or 'stop')`);
  process.exit(2);
}
if (cmd === "status")
  cmdStatus();
else if (cmd === "stop")
  cmdStop();
main();
