#!/usr/bin/env node
// src/daemon.ts
import { mkdirSync as mkdirSync6, readFileSync as readFileSync7, writeFileSync as writeFileSync5, unlinkSync as unlinkSync2 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { join as join10 } from "node:path";

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
    let usage;
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
      const u = json.usage;
      if (u) {
        usage = {
          promptTokens: u.prompt_tokens ?? usage?.promptTokens,
          completionTokens: u.completion_tokens ?? usage?.completionTokens,
          reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? u.prompt_tokens_details?.cached_tokens ?? usage?.reasoningTokens
        };
        onChunk({ content: "", usage });
      }
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
    return { text, toolCalls, finishReason, reasoning: reasoning || undefined, usage };
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
  provider: "groq",
  model: "qwen/qwen3.8-27b",
  providers: {
    groq: {
      type: "openai-compatible",
      baseURL: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      timeoutMs: 240000,
      timeoutIdleMs: 120000,
      models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]
    },
    nvidia: {
      type: "openai-compatible",
      baseURL: "https://api.nvidia.com/v1",
      apiKeyEnv: "NVIDIA_API_KEY",
      timeoutMs: 240000,
      timeoutIdleMs: 120000,
      models: ["nvidia/nemotron-3-ultra-550b-a55b"]
    },
    ollama: {
      type: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "",
      timeoutMs: 240000,
      timeoutIdleMs: 120000,
      models: ["qwen2.5:1.5b", "llama3.1"]
    }
  },
  permissions: {
    destructive: "allow",
    network: "allow",
    filesystem: "full",
    exposeSecrets: false
  },
  maxCostUsd: undefined,
  maxToolOutputChars: 30000
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
function validateConfig(cfg) {
  const errors = [];
  if (!isPlainObject(cfg)) {
    errors.push("config must be a JSON object (top-level {})");
    return errors;
  }
  const o = cfg;
  if (typeof o.provider !== "string" || !o.provider) {
    errors.push('config.provider must be a non-empty string (e.g. "groq", "ollama")');
  }
  if (typeof o.model !== "string" || !o.model) {
    errors.push("config.model must be a non-empty string");
  }
  if (!isPlainObject(o.providers)) {
    errors.push("config.providers must be an object mapping provider names to config");
  } else {
    const providers = o.providers;
    for (const name of Object.keys(providers)) {
      const p = providers[name];
      if (!isPlainObject(p)) {
        errors.push(`providers."${name}" must be an object`);
        continue;
      }
      const pc = p;
      if (typeof pc.type !== "string" || !pc.type) {
        errors.push(`providers."${name}".type must be a non-empty string (e.g. "openai-compatible" or "anthropic")`);
      }
      if (typeof pc.baseURL !== "string" || !pc.baseURL) {
        errors.push(`providers."${name}".baseURL must be a non-empty string`);
      }
      if (typeof pc.apiKeyEnv !== "string") {
        errors.push(`providers."${name}".apiKeyEnv must be a string (can be empty for local providers like ollama)`);
      }
      const models = pc.models;
      if (!Array.isArray(models) || !models.length) {
        errors.push(`providers."${name}".models must be a non-empty array of model IDs`);
      } else if (!models.every((m) => typeof m === "string")) {
        errors.push(`providers."${name}".models must all be strings`);
      }
    }
  }
  if (o.routing !== undefined) {
    if (!isPlainObject(o.routing)) {
      errors.push("config.routing must be an object");
    } else {
      const r = o.routing;
      if (typeof r.strategy !== "string" || !["keyword", "hybrid"].includes(r.strategy)) {
        errors.push(`config.routing.strategy must be "keyword" or "hybrid"`);
      }
      for (const key of ["chatProvider", "chatModel", "heavyProvider", "heavyModel"]) {
        if (r[key] !== undefined && (typeof r[key] !== "string" || !r[key])) {
          errors.push(`config.routing.${key} must be a non-empty string when set`);
        }
      }
    }
  }
  if (o.temperature !== undefined && (typeof o.temperature !== "number" || !isFinite(o.temperature) || o.temperature < 0 || o.temperature > 2)) {
    errors.push("config.temperature must be a number between 0 and 2");
  }
  if (o.maxInputTokens !== undefined && (typeof o.maxInputTokens !== "number" || !isFinite(o.maxInputTokens) || o.maxInputTokens < 1)) {
    errors.push("config.maxInputTokens must be a positive number");
  }
  if (o.maxInputTokensPerMinute !== undefined && (typeof o.maxInputTokensPerMinute !== "number" || !isFinite(o.maxInputTokensPerMinute) || o.maxInputTokensPerMinute < 1)) {
    errors.push("config.maxInputTokensPerMinute must be a positive number");
  }
  if (o.maxCostUsd !== undefined && (typeof o.maxCostUsd !== "number" || !isFinite(o.maxCostUsd) || o.maxCostUsd < 0)) {
    errors.push("config.maxCostUsd must be a non-negative number (e.g. 5 for a $5 cap)");
  }
  if (o.permissions !== undefined) {
    if (!isPlainObject(o.permissions)) {
      errors.push("config.permissions must be an object");
    } else {
      const p = o.permissions;
      if (p.destructive !== undefined && !["allow", "ask", "deny"].includes(p.destructive)) {
        errors.push('config.permissions.destructive must be "allow", "ask", or "deny"');
      }
      if (p.network !== undefined && !["allow", "deny"].includes(p.network)) {
        errors.push('config.permissions.network must be "allow" or "deny"');
      }
      if (p.filesystem !== undefined && !["workspace", "full"].includes(p.filesystem)) {
        errors.push('config.permissions.filesystem must be "workspace" or "full"');
      }
      if (p.exposeSecrets !== undefined && typeof p.exposeSecrets !== "boolean") {
        errors.push("config.permissions.exposeSecrets must be true or false");
      }
    }
  }
  if (o.maxToolOutputChars !== undefined) {
    const n = Number(o.maxToolOutputChars);
    if (!Number.isFinite(n) || n < 2000) {
      errors.push("config.maxToolOutputChars must be a number >= 2000");
    }
  }
  return errors;
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
    const raw = loadJsonFile(effectiveFile);
    const mergedCfg = deepMerge(base, raw);
    const errors = validateConfig(mergedCfg);
    if (errors.length) {
      const userFile = configPaths().userFile;
      const where = userFile ? ` in ${userFile}` : "";
      throw new Error(`config.json has problems that would crash vibecoder:${where}
  ${errors.join(`
  `)}
  Fix the file above and restart.`);
    }
    return mergedCfg;
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
import { dirname as dirname2, join as join3, resolve } from "node:path";
var loaded = new Set;
function envLine(line) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m)
    return null;
  const key = m[1];
  if (!key)
    return null;
  let value = m[2];
  value = value.replace(/\r$/, "");
  value = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  return [key, value];
}
function loadDotEnv() {
  if (process.env.VIBECODER_NO_DOTENV === "1")
    return;
  const candidates = [
    process.env.VIBECODER_ENV_FILE,
    join3(process.cwd(), ".env"),
    join3(packageRoot(), ".env"),
    join3(dirname2(packageRoot()), ".env"),
    join3(homedir2(), ".vibecoder", ".env")
  ].filter((f) => !!f);
  const seen = new Set;
  for (const raw of candidates) {
    const file = resolve(raw);
    if (seen.has(file))
      continue;
    seen.add(file);
    if (loaded.has(file))
      continue;
    loaded.add(file);
    if (!existsSync3(file))
      continue;
    const text = readFileSync3(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine.trim() || rawLine.trim().startsWith("#"))
        continue;
      const kv = envLine(rawLine);
      if (!kv)
        continue;
      const [key, value] = kv;
      if (!(key in process.env) || !process.env[key])
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
  return classifyMessageWhy(text).intent;
}
function classifyMessageWhy(text) {
  const t = (text ?? "").trim();
  if (!t)
    return { intent: "chat", reason: "empty message" };
  for (const re of HEAVY_RULES) {
    const m = re.exec(t);
    if (m)
      return { intent: "heavy", reason: `matched /${ruleLabel(re)}/ on "${truncate(m[0])}"` };
  }
  for (const re of CHAT_RULES) {
    const m = re.exec(t);
    if (m)
      return { intent: "chat", reason: `matched /${ruleLabel(re)}/ on "${truncate(m[0])}"` };
  }
  if (t.length > 300) {
    return { intent: "heavy", reason: `long message (${t.length} chars > 300)` };
  }
  return { intent: "ambiguous", reason: "no rule matched" };
}
function truncate(s) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 40 ? one.slice(0, 40) + "…" : one;
}
var RULE_NAMES = {
  [RE_HEAVY_FENCE.source]: "code fence",
  [RE_HEAVY_IDIOM.source]: "code idiom",
  [RE_HEAVY_FILE.source]: "filename",
  [RE_HEAVY_COMMAND.source]: "task verb",
  [RE_HEAVY_CREATE.source]: "create-a-thing",
  [RE_HEAVY_BUG.source]: "bug/error words",
  [RE_HEAVY_ANALYSIS.source]: "analysis words",
  [RE_HEAVY_LANG_TASK.source]: "language + task",
  [RE_HEAVY_RUN.source]: "cli invocation",
  [RE_CHAT_GREETING.source]: "greeting",
  [RE_CHAT_SOCIAL.source]: "social",
  [RE_CHAT_ACK.source]: "acknowledgement",
  [RE_CHAT_META.source]: "meta about the assistant",
  [RE_CHAT_FACTUAL.source]: "short factual"
};
function ruleLabel(re) {
  return RULE_NAMES[re.source] ?? re.source.slice(0, 24);
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

// src/tools/approval.ts
class ApprovalRequiredError extends Error {
  tool;
  reason;
  args;
  constructor(tool, reason, args = {}) {
    super(`approval required: ${tool} — ${reason}`);
    this.name = "ApprovalRequiredError";
    this.tool = tool;
    this.reason = reason;
    this.args = args;
  }
}
function isApprovalRequired(err) {
  return err instanceof ApprovalRequiredError || typeof err === "object" && err !== null && err.name === "ApprovalRequiredError" && typeof err.reason === "string";
}
function rejectedMessage(tool, reason) {
  return `BLOCKED: the human declined to run ${tool} (${reason}). ` + `Do not retry this action or find a workaround for it. ` + `Either pick a different approach that avoids it, or finish and tell the user ` + `what you needed and why.`;
}
function noPrompterMessage(tool, reason) {
  return `BLOCKED: ${tool} needs approval (${reason}) but no approver is attached to this run. ` + `Unattended runs cannot ask. Either run with destructive:"allow" in config.json, ` + `or set destructive:"deny" so this fails fast and loudly rather than looking approved.`;
}

// src/tools/registry.ts
var registry = new Map;
function registerTool(tool) {
  const name = tool.definition.function.name;
  const prior = registry.get(name);
  if (prior) {
    throw new Error(`Duplicate tool name "${name}". Refusing to overwrite an already-registered tool. ` + `Rename one of them, or make sure the old module is no longer imported.`);
  }
  registry.set(name, tool);
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
    if (isApprovalRequired(err))
      throw err;
    return `ERROR: ${err?.message ?? String(err)}`;
  }
}
function needsApproval(ctx) {
  return ctx.permissions?.destructive === "ask";
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
async function invokeWithApproval(call, toolCtx, callbacks) {
  const name = call.name;
  try {
    return await executeTool(name, call.args, toolCtx);
  } catch (err) {
    if (!isApprovalRequired(err)) {
      const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      return `ERROR: ${msg}`;
    }
    if (!callbacks.confirmTool)
      return noPrompterMessage(name, err.reason);
    const ok = await callbacks.confirmTool(name, call.args, err.reason);
    if (!ok)
      return rejectedMessage(name, err.reason);
    try {
      return await executeTool(name, call.args, toolCtx);
    } catch (retryErr) {
      if (isApprovalRequired(retryErr))
        return noPrompterMessage(name, retryErr.reason);
      const msg = retryErr && typeof retryErr === "object" && "message" in retryErr ? String(retryErr.message) : String(retryErr);
      return `ERROR: ${msg}`;
    }
  }
}
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
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let sawUsage = false;
  const usageOrUndefined = () => sawUsage ? { promptTokens, completionTokens, reasoningTokens } : undefined;
  const costCap = options.maxCostUsd;
  const rates = options.costRates;
  const spentUsd = () => rates ? (promptTokens * rates.input + completionTokens * rates.output + reasoningTokens * (rates.reasoning ?? rates.output)) / 1e6 : 0;
  for (let step = 0;step < maxSteps; step++) {
    if (costCap !== undefined && rates && sawUsage && spentUsd() >= costCap) {
      const spent = spentUsd();
      const msg = `(stopped at the cost cap: ~$${spent.toFixed(4)} of the configured $${costCap.toFixed(2)}. ` + `The work so far is on disk — /diff shows what changed. Raise maxCostUsd in config.json, ` + `or split the task. This is an estimate from token counts, so treat it as close, not exact.)`;
      callbacks.onModelText?.(`
${msg}
`);
      callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "cost_cap" });
      return {
        finalText: msg,
        toolCalls,
        steps: step,
        aborted: false,
        usage: usageOrUndefined(),
        costCapHit: { limitUsd: costCap, spentUsd: spent }
      };
    }
    if (options.signal?.aborted) {
      callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
      return { finalText: `
[interrupted]`, toolCalls, steps: step, aborted: true, usage: usageOrUndefined() };
    }
    callbacks.onStepUpdate?.(step + 1, toolCalls, maxSteps);
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
          if (result.usage) {
            sawUsage = true;
            promptTokens += result.usage.promptTokens ?? 0;
            completionTokens += result.usage.completionTokens ?? 0;
            reasoningTokens += result.usage.reasoningTokens ?? 0;
          }
          break;
        } catch (err) {
          if (err instanceof ContextTooLargeError && retryBudgetDelta === 0) {
            retryBudgetDelta = 512;
            continue;
          }
          if (options.signal?.aborted || err?.name === "AbortError") {
            callbacks.onDone?.({ text: "", toolCalls: [], finishReason: "aborted" });
            return { finalText: `
[interrupted]`, toolCalls, steps: step, aborted: true, usage: usageOrUndefined() };
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
          aborted: false,
          usage: usageOrUndefined()
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
      return { finalText: result.text, toolCalls, steps: step + 1, aborted: false, usage: usageOrUndefined() };
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
    const PARALLEL_THRESHOLD = 2;
    const parallelCalls = parsed.filter((c) => c.name);
    const runOne = async (call) => {
      toolCalls++;
      if (!call.name) {
        const id = call.id || `call_${toolCalls}`;
        return {
          call,
          message: {
            role: "tool",
            tool_call_id: id,
            content: "ERROR: the model emitted a tool call with no function name. Reissue a valid tool call or finish by responding with plain text.",
            name: "unknown"
          },
          output: ""
        };
      }
      const name = call.name;
      callbacks.onToolStart?.(name, call.args);
      let output;
      let approved = true;
      if (callbacks.confirmTool) {
        approved = await callbacks.confirmTool(name, call.args);
      }
      if (!approved) {
        output = rejectedMessage(name, "you declined it at the approval prompt");
      } else {
        output = await invokeWithApproval(call, options.toolCtx, callbacks);
      }
      callbacks.onToolEnd?.(call.name, output);
      return {
        call,
        message: { role: "tool", tool_call_id: call.id, content: output, name: call.name },
        output
      };
    };
    const approvalMayFire = needsApproval(options.toolCtx);
    let results;
    if (parallelCalls.length >= PARALLEL_THRESHOLD && !callbacks.confirmTool && !approvalMayFire) {
      toolCalls += parallelCalls.length;
      for (const call of parallelCalls) {
        callbacks.onToolStart?.(call.name, call.args);
      }
      const outputs = await Promise.all(parallelCalls.map(async (call) => {
        let output;
        try {
          output = await executeTool(call.name, call.args, options.toolCtx);
        } catch (err) {
          output = `ERROR: ${err?.message ?? String(err)}`;
        }
        callbacks.onToolEnd?.(call.name, output);
        return { call, output };
      }));
      results = outputs.map((r) => ({
        ...r,
        message: { role: "tool", tool_call_id: r.call.id, content: r.output, name: r.call.name }
      }));
      const noNameResults = await Promise.all(parsed.filter((c) => !c.name).map((call) => runOne(call)));
      results = [...noNameResults, ...results];
    } else {
      results = [];
      for (const call of parsed) {
        results.push(await runOne(call));
      }
    }
    for (const r of results) {
      messages.push(r.message);
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
  return { finalText: maxMsg, toolCalls, steps: maxSteps, aborted: false, usage: usageOrUndefined() };
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
  const now = Date.now();
  const candidates = tasks.filter((t) => {
    if (t.status === "queued")
      return true;
    if (t.status === "running" && t.runnerPid && !processExists(t.runnerPid))
      return true;
    if (t.status === "failed" && t.attempts !== undefined && t.attempts < 5) {
      if (!t.retryAfter || now >= t.retryAfter)
        return true;
    }
    return false;
  }).sort((a, b) => a.createdAt - b.createdAt);
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
function markTaskFailed(id, error, attempts, retryAfter) {
  return withLock(() => update(id, { status: "failed", error, finishedAt: Date.now(), runnerPid: undefined, attempts, retryAfter }));
}
function markTaskRetry(id, attempts) {
  const now = Date.now();
  const backoffMs = Math.min(300000, 30000 * Math.pow(2, attempts - 1));
  return withLock(() => update(id, {
    status: "failed",
    runnerPid: undefined,
    error: undefined,
    attempts,
    retryAfter: now + backoffMs
  }));
}
function resetStale() {
  return withLock(() => {
    const tasks = read();
    const now = Date.now();
    let n = 0;
    for (const t of tasks) {
      if (t.status === "running") {
        if (!t.runnerPid || !processExists(t.runnerPid)) {
          n++;
          t.status = "queued";
          t.runnerPid = undefined;
          t.retryAfter = undefined;
        }
      }
      if (t.status === "queued") {
        t.runnerPid = undefined;
        if (t.attempts !== undefined && t.attempts >= 5) {
          t.status = "failed";
          t.retryAfter = undefined;
        }
      }
      if (t.status === "failed" && t.attempts !== undefined && t.attempts < 5) {
        if (!t.retryAfter || now >= t.retryAfter) {
          n++;
          t.status = "queued";
          t.retryAfter = undefined;
        }
      }
    }
    write(tasks);
    return n;
  });
}

// src/tools/proc.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync as existsSync5 } from "node:fs";
import { platform } from "node:os";
function killProcessGroup(child, signal = "SIGKILL") {
  if (child.pid === undefined || child.pid <= 0)
    return;
  if (platform() === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {}
    try {
      child.kill(signal);
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}
function resolveCommand(cmd) {
  if (cmd.includes("/") || cmd.includes("\\"))
    return cmd;
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(pathSep).filter(Boolean);
  const exts = [""].concat((process.env.PATHEXT ?? ".EXE;.BAT;.CMD;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC").split(pathSep).map((e) => e.toLowerCase()));
  for (const dir of dirs) {
    const base = join22(dir, cmd);
    for (const ext of exts) {
      const candidate = ext ? base + ext : base;
      if (existsSync5(candidate))
        return candidate;
    }
  }
  if (platform() !== "win32") {
    const prefixes = ["/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin", "/usr/local/sbin"];
    for (const p of prefixes) {
      const candidate = join22(p, cmd);
      if (existsSync5(candidate))
        return candidate;
    }
    try {
      const lookedUp = spawnSync("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
      if (lookedUp && lookedUp.stdout && existsSync5(lookedUp.stdout.toString().trim())) {
        return lookedUp.stdout.toString().trim();
      }
    } catch {}
  } else {
    const winPrefixes = [
      "C:\\Users\\Administrator\\AppData\\Local\\hermes\\git\\usr\\bin",
      "C:\\Program Files\\Git\\usr\\bin",
      "C:\\Program Files (x86)\\Git\\usr\\bin",
      "C:\\msys64\\usr\\bin",
      "C:\\msys64\\mingw64\\bin",
      "C:\\Program Files\\Git\\bin"
    ];
    for (const p of winPrefixes) {
      const candidate = join22(p, cmd);
      if (existsSync5(candidate))
        return candidate;
      const exeCandidate = candidate + ".exe";
      if (existsSync5(exeCandidate))
        return exeCandidate;
    }
    if (cmd === "bash" || cmd === "sh") {
      return cmd;
    }
  }
  return cmd;
}
function join22(a, b) {
  if (a.endsWith("/") || a.endsWith("\\"))
    return a + b;
  return a + "/" + b;
}
var pathSep = process.platform === "win32" ? ";" : ":";
function spawnCollect(opts) {
  return new Promise((resolvePromise) => {
    let child = null;
    try {
      const resolvedCmd = resolveCommand(opts.cmd[0]);
      child = spawn(resolvedCmd, opts.cmd.length > 1 ? opts.cmd.slice(1) : [], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: opts.detached ?? true
      });
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      resolvePromise({ stdout: "", stderr: `spawn error: ${msg}`, exitCode: -1, timedOut: false, aborted: false });
      return;
    }
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
        settle(-1);
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

// src/permissions.ts
import { isAbsolute, join as join5, resolve as resolve2, dirname as dirname4, basename } from "node:path";
import { realpathSync } from "node:fs";
import { homedir as homedir4 } from "node:os";
function resolvePermissions(config, workspaceRoot) {
  const p = config.permissions ?? {};
  return {
    destructive: p.destructive ?? "allow",
    network: p.network ?? "allow",
    filesystem: p.filesystem ?? "full",
    workspaceRoot,
    exposeSecrets: p.exposeSecrets ?? false
  };
}
function isPathAllowed(path, perms) {
  if (perms.filesystem === "full")
    return true;
  const resolved = resolvePath(path);
  const root = resolvePath(perms.workspaceRoot);
  if (resolved === root)
    return true;
  const sep = process.platform === "win32" ? "\\" : "/";
  const norm = (p) => {
    const n = p.replace(/[\\/]+/g, sep);
    const folded = process.platform === "win32" ? n.toLowerCase() : n;
    return folded.length > 1 && folded.endsWith(sep) ? folded.slice(0, -1) : folded;
  };
  const nr = norm(resolved);
  const nroot = norm(root);
  return nr.startsWith(nroot + sep);
}
var NESTING_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash", "fish", "busybox", "env", "sudo", "doas", "nohup", "timeout", "xargs", "watch", "stdbuf", "nice", "command", "builtin", "eval"]);
function readParen(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open;i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote)
        quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "(")
      depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0)
        return { body: src.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}
function extractNested(src, depth, acc) {
  if (depth > 6)
    return src;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > 0) {
        acc.push(src.slice(i + 1, close));
        out += " ";
        i = close + 1;
        continue;
      }
    }
    if ((c === "$" || c === "<" || c === ">") && src[i + 1] === "(") {
      const got = readParen(src, i + 1);
      if (got) {
        acc.push(got.body);
        out += " ";
        i = got.end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}
function splitSegments(src) {
  const segs = [];
  let cur = "";
  let quote = null;
  for (let i = 0;i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') {
        cur += src[++i] ?? "";
        continue;
      }
      if (c === quote)
        quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\\") {
      cur += c + (src[++i] ?? "");
      continue;
    }
    if (c === `
` || c === ";" || c === "|") {
      if (cur.trim())
        segs.push(cur);
      cur = "";
      continue;
    }
    if (c === "&") {
      if (cur.trim())
        segs.push(cur);
      cur = "";
      if (src[i + 1] === "&")
        i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim())
    segs.push(cur);
  return segs;
}
function tokenize(seg) {
  const tokens = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0;i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        cur += seg[++i] ?? "";
        has = true;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\") {
      cur += seg[++i] ?? "";
      has = true;
      continue;
    }
    if (c === "#" && !has)
      break;
    if (/\s/.test(c)) {
      if (has || cur) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur)
    tokens.push(cur);
  return tokens;
}
function stripAssignments(argv) {
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*(\+)?=/.test(argv[i]))
    i++;
  return argv.slice(i);
}
function expandVars(argv, vars) {
  if (!vars.size)
    return argv;
  return argv.map((tok) => {
    if (!tok.includes("$"))
      return tok;
    return tok.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) => vars.has(name) ? vars.get(name) : whole);
  });
}
function stripQuotes(v) {
  const t = v.trim();
  if (t.length > 1 && (t.startsWith('"') && t.endsWith('"') || t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
function commandName(word) {
  let w = word;
  if (/[\\/]/.test(w))
    w = w.split(/[\\/]/).pop() ?? w;
  return w.replace(/\.(exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
}
var DESTRUCTIVE_FLAGS = {
  git: [
    { flags: /\b(clean)\b[\s\S]*\s-[a-z]*[fd]/, why: "git clean removing untracked files" },
    { flags: /\breset\b[\s\S]*--hard/, why: "git reset --hard discarding committed work" },
    { flags: /\bcheckout\b[\s\S]*\s--\s/, why: "git checkout -- discarding working-tree changes" },
    { flags: /\brestore\b/, why: "git restore overwriting working-tree files" },
    { flags: /\bpush\b[\s\S]*\s--force(?!-with-lease)/, why: "git push --force rewriting remote history" },
    { flags: /\bremote\b[\s\S]*\bset-url\b/, why: "git remote set-url repointing the remote" },
    { flags: /\bbranch\b[\s\S]*\s-D\b/, why: "git branch -D force-deleting a branch" }
  ],
  find: [
    { flags: /\s-(delete|exec|execdir|ok)\b/, why: "find deleting or executing on matches" }
  ],
  chmod: [{ flags: /\s-R\b/, why: "recursive chmod" }],
  chown: [{ flags: /\s-R\b/, why: "recursive chown" }],
  dd: [{ flags: /\bof=/, why: "dd writing raw data to a device or file" }],
  powershell: [
    { flags: /\b(Remove-Item|Remove-ItemProperty|Clear-Content|rd|rm|del|erase)\b/i, why: "PowerShell file/directory removal" },
    { flags: /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, why: "disk/volume destruction" },
    { flags: /\bStop-Process|Stop-Service|Restart-Computer|Stop-Computer\b/i, why: "process/system control" }
  ],
  pwsh: [
    { flags: /\b(Remove-Item|Clear-Content|rd|rm|del|erase)\b/i, why: "PowerShell file/directory removal" },
    { flags: /\bStop-Process|Stop-Service|Restart-Computer|Stop-Computer\b/i, why: "process/system control" }
  ],
  cmd: [
    { flags: /\b(rd|rmdir)\b[\s\S]*\/s/i, why: "recursive directory removal" }
  ],
  registry: [{ flags: /\b(delete|remove)\b/i, why: "registry deletion" }],
  cipher: [{ flags: /\s\/w\b/, why: "cipher wiping free space" }],
  diskpart: [{ flags: /\bclean\b/, why: "diskpart clean erasing a disk" }]
};
var DESTRUCTIVE_CMDS = {
  rm: "file/directory removal (rm)",
  rmdir: "directory removal (rmdir)",
  unlink: "file removal (unlink)",
  shred: "secure file overwrite (shred)",
  srm: "secure file removal (srm)",
  dd: "low-level data copying (dd)",
  mkfs: "filesystem creation (mkfs)",
  mkswap: "swap creation (mkswap)",
  fdisk: "partition table manipulation (fdisk)",
  parted: "partition manipulation (parted)",
  truncate: "file truncation (truncate)",
  kill: "process termination (kill)",
  pkill: "process termination (pkill)",
  killall: "process termination (killall)",
  taskkill: "process termination (taskkill)",
  systemctl: "systemd service control (systemctl)",
  service: "service control (service)",
  reboot: "system reboot",
  shutdown: "system shutdown",
  halt: "system halt",
  poweroff: "system poweroff",
  init: "system init control",
  del: "file removal (del)",
  erase: "file removal (erase)",
  rd: "recursive directory removal (rd)",
  format: "filesystem format (format)",
  cipher: "file/disk wiping (cipher)",
  bcdedit: "boot configuration edit (bcdedit)",
  diskpart: "disk partitioning (diskpart)"
};
var NETWORK_CMDS = {
  curl: "network client (curl)",
  wget: "network client (wget)",
  nc: "network client (nc)",
  ncat: "network client (ncat)",
  netcat: "network client (netcat)",
  socat: "network client (socat)",
  telnet: "network client (telnet)",
  ssh: "remote shell (ssh)",
  scp: "remote copy (scp)",
  sftp: "remote file transfer (sftp)",
  rsync: "remote sync (rsync)",
  ftp: "file transfer (ftp)",
  tftp: "file transfer (tftp)",
  aria2c: "download client (aria2c)",
  http: "HTTP client (http)",
  httpie: "HTTP client (http)",
  xh: "HTTP client (xh)",
  dig: "DNS lookup (dig)",
  nslookup: "DNS lookup (nslookup)",
  host: "DNS lookup (host)",
  ping: "network probe (ping)",
  traceroute: "network trace (traceroute)",
  mtr: "network trace (mtr)",
  whois: "whois lookup (whois)",
  arp: "ARP inspection (arp)",
  nmap: "port scanner (nmap)",
  openssl: "TLS client (openssl s_client)",
  "ssh-keyscan": "host key scan (ssh-keyscan)",
  bitsadmin: "BITS transfer (bitsadmin)",
  certutil: "certutil download/URL fetch"
};
var NETWORK_CMDFLAGS = {
  git: [{ flags: /\b(clone|fetch|pull|push|submodule|remote)\b/, why: "git network operation" }],
  powershell: [
    { flags: /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|Net\.WebClient|System\.Net\.Http)\b/i, why: "PowerShell web request" }
  ],
  pwsh: [
    { flags: /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|Net\.WebClient|System\.Net\.Http)\b/i, why: "PowerShell web request" }
  ]
};
var NETWORK_INTERPRETERS = {
  python: "python",
  python3: "python",
  py: "python",
  node: "node",
  deno: "deno",
  bun: "bun",
  perl: "perl",
  ruby: "ruby",
  php: "php",
  lua: "lua",
  osascript: "osascript",
  curl_: "curl"
};
var INLINE_EVAL_FLAGS = /^(-[a-z]*[ce]|--eval|--execute|-Command|-EncodedCommand|-c)$/i;
var HELP_FLAGS = new Set([
  "-h",
  "--help",
  "-help",
  "/?",
  "/h",
  "-v",
  "--version",
  "--usage"
]);
function isHelpInvocation(cmd) {
  return cmd.argv.slice(1).some((a) => HELP_FLAGS.has(a.toLowerCase()));
}
function destructiveReasonFor(cmd) {
  const name = commandName(cmd.argv[0] ?? "");
  if (!name)
    return null;
  if (isHelpInvocation(cmd))
    return null;
  const base = DESTRUCTIVE_CMDS[name];
  if (base)
    return base;
  if (name.startsWith("mkfs."))
    return `filesystem creation (${name})`;
  for (const { flags, why } of DESTRUCTIVE_FLAGS[name] ?? []) {
    if (flags.test(cmd.raw))
      return why;
  }
  if (name === "find") {
    const ex = cmd.argv.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok");
    if (ex >= 0) {
      const inner = stripAssignments(cmd.argv.slice(ex + 1)).map(commandName);
      const innerName = inner[0] ?? "";
      if (DESTRUCTIVE_CMDS[innerName])
        return `find -exec ${innerName} (${DESTRUCTIVE_CMDS[innerName]})`;
    }
  }
  if (name === "powershell" || name === "pwsh") {
    const joined = cmd.argv.join(" ");
    if (/\b(Remove-Item|Clear-Content|rd\s|rm\s|del\s|erase\s|Stop-Process|Stop-Service|Format-Volume)\b/i.test(joined)) {
      return "PowerShell destructive cmdlet";
    }
  }
  return null;
}
function networkReasonFor(cmd) {
  const name = commandName(cmd.argv[0] ?? "");
  if (!name)
    return null;
  const base = NETWORK_CMDS[name];
  if (base)
    return base;
  for (const { flags, why } of NETWORK_CMDFLAGS[name] ?? []) {
    if (flags.test(cmd.raw))
      return why;
  }
  if (NETWORK_INTERPRETERS[name]) {
    const inline = cmd.argv.slice(1).find((a) => INLINE_EVAL_FLAGS.test(a));
    if (inline)
      return `${NETWORK_INTERPRETERS[name]} inline code (${inline}) can open network connections`;
  }
  if (/\b(Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b/i.test(cmd.raw)) {
    return "PowerShell web request";
  }
  return null;
}
function parseCommands(command, depth = 0) {
  if (depth > 8)
    return [];
  const vars = new Map;
  const nested = [];
  const stripped = extractNested(command, depth, nested);
  const out = [];
  for (const body of nested)
    out.push(...parseCommands(body, depth + 1));
  for (const seg of splitSegments(stripped)) {
    const argv = tokenize(seg);
    if (!argv.length)
      continue;
    for (const tok of argv) {
      const m = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)(\+)?=([\s\S]*)$/);
      if (m)
        vars.set(m[1], stripQuotes(m[3]));
    }
    const effective = stripAssignments(argv);
    if (!effective.length)
      continue;
    out.push({ argv: expandVars(effective, vars), raw: seg });
    const name = commandName(effective[0]);
    if (!name)
      continue;
    if (NESTING_SHELLS.has(name)) {
      const rest = effective.slice(1);
      if (name === "xargs") {
        const inner = rest.filter((a, i) => i === 0 ? !a.startsWith("-") : !/^[{}]$/.test(a));
        if (inner.length)
          out.push(...parseCommands(inner.join(" "), depth + 1));
      } else if (name === "env" || name === "nohup" || name === "stdbuf" || name === "nice" || name === "timeout" || name === "watch" || name === "command" || name === "builtin") {
        const inner = stripAssignments(rest.filter((a) => !/^-/.test(a) || /^-[A-Za-z_]+=/.test(a)));
        if (inner.length)
          out.push(...parseCommands(inner.join(" "), depth + 1));
      } else {
        const ci = rest.findIndex((a) => a === "-c" || a === "--login" || a === "-lc" || a === "-lic");
        if (ci >= 0 && rest[ci + 1])
          out.push(...parseCommands(rest[ci + 1], depth + 1));
        else if (rest.length && !rest[0].startsWith("-")) {
          out.push(...parseCommands(rest.join(" "), depth + 1));
        }
      }
    }
  }
  return out;
}
function destructiveReason(command) {
  for (const cmd of parseCommands(command)) {
    const reason = destructiveReasonFor(cmd);
    if (reason)
      return reason;
    if (/(^|[^0-9<>])>{1,2}|\d>&/.test(cmd.raw)) {
      const target = cmd.raw.match(/>{1,2}\s*"?([^\s"';|&]+)"?/);
      const t = target?.[1] ?? "";
      const isScratch = t === "/dev/null" || t === "/dev/stdout" || t === "NUL" || t.startsWith("/tmp/") || t.startsWith("/var/tmp/") || t.startsWith("C:/Windows/Temp/") || t.startsWith("C:\\Windows\\Temp\\");
      if (!isScratch)
        return "output redirection (may overwrite files)";
    }
    if (commandName(cmd.argv[0] ?? "") === "tee")
      return "tee writes to a file";
  }
  return null;
}
function checkNetworkCommand(command, perms) {
  if (perms.network === "allow")
    return null;
  const cmds = parseCommands(command);
  for (const cmd of cmds) {
    const reason = networkReasonFor(cmd);
    if (reason)
      return `BLOCKED (${perms.network}): ${reason}`;
  }
  for (const cmd of cmds) {
    const squashed = (cmd.argv[0] ?? "").replace(/[\s${}()]/g, "").toLowerCase();
    if (squashed && NETWORK_CMDS[squashed]) {
      return `BLOCKED (${perms.network}): ${NETWORK_CMDS[squashed]} (obfuscated invocation)`;
    }
  }
  if (/\$\{?IFS\}?/.test(command)) {
    for (const cmd of cmds) {
      if (/\b(curl|wget|nc|ncat|ssh|scp|ftp|telnet|git|python3?|node|openssl)\b/i.test(cmd.raw)) {
        return `BLOCKED (${perms.network}): IFS-expanded network invocation`;
      }
    }
  }
  return null;
}
function resolvePath(p) {
  let expanded = p;
  if (expanded === "~")
    expanded = homedir4();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join5(homedir4(), expanded.slice(2));
  }
  if (!isAbsolute(expanded))
    expanded = join5(process.cwd(), expanded);
  return realPath(resolve2(expanded));
}
function realPath(abs) {
  const tail = [];
  let current = abs;
  for (let i = 0;i < 64; i++) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join5(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname4(current);
      if (parent === current)
        return abs;
      tail.push(basename(current));
      current = parent;
    }
  }
  return abs;
}
var SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|SESSION|COOKIE|AUTH)/i;
function filterEnv(env, perms) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined)
      continue;
    if (perms?.exposeSecrets) {
      out[k] = v;
      continue;
    }
    if (SECRET_NAME.test(k) && !k.startsWith("VIBECODER_"))
      continue;
    out[k] = v;
  }
  return out;
}

// src/runtime.ts
var _config = null;
function numberSetting(key, fallback, min = 0) {
  const v = _config?.[key];
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < min)
    return fallback;
  return n;
}

// src/tools/bash.ts
function resolveMaxOutput() {
  const fromEnv = Number(process.env.VIBECODER_MAX_OUTPUT);
  if (Number.isFinite(fromEnv) && fromEnv >= 2000)
    return Math.floor(fromEnv);
  return numberSetting("maxToolOutputChars", 30000, 2000);
}
function capOutput(output, max) {
  if (output.length <= max)
    return output;
  const headLen = Math.max(2000, Math.floor(max * 0.3));
  const tailLen = Math.max(2000, max - headLen - 160);
  const head = output.slice(0, headLen);
  const tail = output.slice(output.length - tailLen);
  const dropped = output.length - headLen - tailLen;
  return `${head}
` + `[... ${dropped} characters omitted from the middle — this output was ${output.length} chars, ` + `the cap is ${max}. Raise it with VIBECODER_MAX_OUTPUT=<n> or config.json maxToolOutputChars, ` + `or re-run narrowed to what you need. ...]
` + `${tail}`;
}
var PLAN_MODE_BANNED = {
  rm: "file/directory-destroying command",
  rmdir: "directory removal",
  del: "file removal (del)",
  erase: "file removal (erase)",
  rd: "directory removal (rd)",
  shred: "secure file overwrite",
  mv: "moving/overwriting files",
  dd: "low-level data copying (dd)",
  mkfs: "filesystem creation",
  truncate: "file truncation",
  fdisk: "partition manipulation",
  parted: "partition manipulation",
  npm: "package manager",
  pnpm: "package manager",
  yarn: "package manager",
  bun: "runtime/package manager",
  deno: "runtime/package manager",
  pip: "pip install/remove",
  pip3: "pip install/remove",
  apt: "system package manager",
  "apt-get": "system package manager",
  dnf: "system package manager",
  yum: "system package manager",
  zypper: "system package manager",
  brew: "system package manager",
  cargo: "language package manager",
  go: "language package manager",
  kill: "process termination",
  pkill: "process termination",
  killall: "process termination",
  taskkill: "process termination",
  systemctl: "process/system control",
  service: "process/system control",
  reboot: "process/system control",
  shutdown: "process/system control",
  halt: "process/system control",
  poweroff: "process/system control",
  sudo: "sudo",
  doas: "privilege escalation",
  git: "git state mutation",
  gh: "GitHub CLI mutation"
};
var PLAN_MODE_GIT_ALLOWED = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "tag",
  "blame",
  "rev-parse",
  "ls-files",
  "describe",
  "shortlog",
  "config",
  "stash"
]);
var PLAN_MODE_GIT_READONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "describe"
]);
var HELP_FLAGS2 = new Set(["-h", "--help", "-help", "/?", "/h", "-v", "--version"]);
function findIsDestructive(argv) {
  for (const a of argv) {
    if (a === "-delete" || a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir")
      return true;
  }
  return false;
}
function planBannedReason(command) {
  for (const cmd of parseCommands(command)) {
    const name = (cmd.argv[0] ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
    if (cmd.argv.slice(1).some((a) => HELP_FLAGS2.has(a.toLowerCase())))
      continue;
    if (name === "find") {
      if (findIsDestructive(cmd.argv))
        return "find deleting or executing on matches";
      continue;
    }
    const why = PLAN_MODE_BANNED[name];
    if (!why)
      continue;
    if (name === "git") {
      const sub = (cmd.argv[1] ?? "").toLowerCase();
      if (PLAN_MODE_GIT_READONLY.has(sub))
        continue;
      if ((sub === "branch" || sub === "remote" || sub === "tag") && !cmd.argv.slice(2).some((a) => /^-/.test(a) && !/^(--list|-l|-v|-a|--get|get)$/i.test(a))) {
        continue;
      }
      if (sub === "stash" && (cmd.argv[2] ?? "") === "list")
        continue;
      if (sub === "config" && (cmd.argv[2] ?? "") === "--get")
        continue;
      return `git ${sub || "state mutation"}`;
    }
    if (name === "bun" || name === "go") {
      const sub = (cmd.argv[1] ?? "").toLowerCase();
      if (sub === "test" || sub === "build" || sub === "run" || sub === "vet")
        continue;
    }
    if (name === "cargo") {
      if (["test", "build", "check", "clippy"].includes((cmd.argv[1] ?? "").toLowerCase()))
        continue;
    }
    if (name === "python" || name === "python3" || name === "py" || name === "node") {
      continue;
    }
    if (name === "mv") {
      return why;
    }
    return why;
  }
  for (const cmd of parseCommands(command)) {
    if (/(^|[^0-9<>])>{1,2}|\d>&/.test(cmd.raw)) {
      const t = cmd.raw.match(/>{1,2}\s*"?([^\s"';|&]+)"?/)?.[1] ?? "";
      if (t !== "/dev/null" && t !== "NUL" && !t.startsWith("/tmp/") && !t.startsWith("/var/tmp/")) {
        return "output redirection writes a file";
      }
    }
    if ((cmd.argv[0] ?? "").toLowerCase() === "tee")
      return "tee writes to a file";
  }
  return null;
}
function bannedReason(command) {
  return planBannedReason(command);
}
var SECRET_FILE = /(^|[\s"'=/\\])\.env(\.[A-Za-z0-9_-]+)?($|[\s"';|&])/;
function secretFileInvolved(command) {
  for (const cmd of parseCommands(command)) {
    for (const tok of cmd.argv) {
      if (SECRET_FILE.test(tok))
        return tok.replace(/["']/g, "");
    }
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
    const permissions = ctx.permissions;
    const command = String(args.command ?? "");
    if (ctx.planPhase) {
      const why = planBannedReason(command);
      if (why)
        return `BLOCKED IN PLAN MODE (read-only): ${why}. Use read-only commands (ls, grep, cat, git status/diff/log, running tests) to investigate, and describe any changes you would make in your PLAN instead.`;
    }
    if (!permissions?.exposeSecrets) {
      const secret = secretFileInvolved(command);
      if (secret) {
        return `BLOCKED: refusing to read ${secret} through bash — it holds live credentials. Use env_get("<KEY>") to read a single value (it masks), or run with --expose-secrets if you truly need the raw file.`;
      }
    }
    if (permissions) {
      if (permissions.destructive !== "allow") {
        const reason = destructiveReason(command);
        if (reason) {
          if (permissions.destructive === "deny") {
            return `BLOCKED (deny): ${reason}`;
          }
          throw new ApprovalRequiredError("bash", reason, args);
        }
      }
      const networkCheck = checkNetworkCommand(command, permissions);
      if (networkCheck) {
        return networkCheck;
      }
      if (permissions.filesystem === "workspace" && args.workdir) {
        const workdir = String(args.workdir);
        if (!isPathAllowed(workdir, permissions)) {
          return `BLOCKED: workdir "${workdir}" is outside the allowed workspace (${permissions.workspaceRoot}). Use a path within the workspace.`;
        }
      }
    }
    const cwd = args.workdir ? String(args.workdir) : ctx.cwd;
    const timeout = Math.max(0, Number(args.timeout ?? 120000));
    let res;
    try {
      res = await spawnCollect({
        cmd: ["bash", "-lc", command],
        cwd,
        env: { ...filterEnv(process.env, permissions), NO_COLOR: "1" },
        timeoutMs: timeout,
        signal: ctx.signal
      });
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      return `ERROR: cannot run command: ${msg}`;
    }
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
    const limit = resolveMaxOutput();
    if (output.length > limit) {
      output = capOutput(output, limit);
    }
    return output;
  }
});

// src/tools/fs-utils.ts
import * as path from "path";
function resolve4(p, ctx) {
  if (path.isAbsolute(p))
    return path.resolve(p);
  return path.resolve(ctx.cwd, p);
}
function pathDenied(p, ctx) {
  const perms = ctx.permissions;
  if (!perms)
    return null;
  const abs = resolve4(p, ctx);
  if (isPathAllowed(abs, perms))
    return null;
  return `BLOCKED: ${abs} is outside the allowed workspace (${perms.workspaceRoot}). Set permissions.filesystem to "full" to allow it.`;
}

// src/tools/files.ts
import { dirname as dirname7, join as join8 } from "node:path";
import { mkdirSync as mkdirSync5, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";

// src/self-edit.ts
import { createHash } from "node:crypto";
import { copyFileSync, existsSync as existsSync6, mkdirSync as mkdirSync3, readFileSync as readFileSync5, appendFileSync, readdirSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join6, resolve as resolve5, dirname as dirname5 } from "node:path";
var LEDGER_NAME = "SELF_EDITS.jsonl";
function repoRoot() {
  const env = process.env.VIBECODER_REPO_ROOT;
  if (env)
    return resolve5(env);
  return dirname5(packageRoot());
}
function installMode() {
  if (process.env.VIBECODER_REPO_ROOT)
    return "repo";
  const root = dirname5(packageRoot());
  if (existsSync6(join6(root, ".git")) || existsSync6(join6(packageRoot(), ".git")))
    return "repo";
  return "user";
}
function userDataRoot() {
  if (process.env.VIBECODER_SESSION_DIR)
    return process.env.VIBECODER_SESSION_DIR;
  return join6(homedir5(), ".vibecoder");
}
function repoConfigFile() {
  return resolvePackageFile("config.json");
}
function liveConfigFile() {
  const repo = reposWhere();
  if (repo && installMode() === "repo")
    return repo.config;
  const repoCfg = repoConfigFile();
  if (installMode() === "repo" && repoCfg && !existsSync6(userConfigFile()))
    return repoCfg;
  return userConfigFile();
}
function ledgerPath() {
  return installMode() === "repo" ? join6(repoRoot(), LEDGER_NAME) : join6(userDataRoot(), LEDGER_NAME);
}
function backupsDir() {
  return join6(userDataRoot(), "backups");
}
function isSameFile(a, b) {
  return resolve5(a) === resolve5(b);
}
function reposWhere() {
  if (process.env.VIBECODER_REPO_ROOT) {
    const root = resolve5(process.env.VIBECODER_REPO_ROOT);
    return { root, config: join6(root, "config.json"), env: join6(root, ".env") };
  }
  return null;
}
function isSelfFile(abs) {
  const a = resolve5(abs);
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
    mkdirSync3(dirname5(ledgerPath()), { recursive: true });
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
  const file = join6(dir, `config-${ts}.json`);
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

// src/changelog.ts
import { createHash as createHash2 } from "node:crypto";
import {
  appendFileSync as appendFileSync2,
  copyFileSync as copyFileSync2,
  existsSync as existsSync7,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync6,
  rmSync as rmSync2,
  unlinkSync,
  writeFileSync as writeFileSync4
} from "node:fs";
import { homedir as homedir6 } from "node:os";
import { dirname as dirname6, isAbsolute as isAbsolute3, join as join7, relative, resolve as resolve6, sep } from "node:path";
var CHANGE_LOG_NAME = "changes.jsonl";
var UNDO_DIR_NAME = "undo";
var MAX_UNDO_BYTES = 512 * 1024;
function dataRoot() {
  const env = process.env.VIBECODER_SESSION_DIR;
  return env || join7(homedir6(), ".vibecoder");
}
function changeLogPath() {
  return join7(dataRoot(), CHANGE_LOG_NAME);
}
function undoDir() {
  return join7(dataRoot(), UNDO_DIR_NAME);
}
function isChangeStorePath(abs) {
  const a = resolve6(abs);
  if (a === resolve6(changeLogPath()))
    return true;
  const dir = resolve6(undoDir());
  return a === dir || a.startsWith(dir + sep);
}
function shaOf2(text) {
  return createHash2("sha256").update(text).digest("hex");
}
var currentSession = "";
function recordChange(params) {
  const abs = resolve6(params.path);
  const existed = params.beforeText !== null;
  const entry = {
    ts: new Date().toISOString(),
    sessionId: currentSession,
    tool: params.tool,
    path: abs,
    rel: displayPath(abs, params.cwd),
    beforeSha: params.beforeText === null ? "" : shaOf2(params.beforeText),
    afterSha: shaOf2(params.afterText),
    existedBefore: existed,
    undoFile: null,
    beforeBytes: params.beforeText === null ? 0 : Buffer.byteLength(params.beforeText),
    afterBytes: Buffer.byteLength(params.afterText),
    note: params.note ?? ""
  };
  if (existed && params.beforeText !== null) {
    const bytes = Buffer.byteLength(params.beforeText);
    if (bytes <= MAX_UNDO_BYTES) {
      const name = `${entry.beforeSha.slice(0, 16)}.bak`;
      const dest = join7(undoDir(), name);
      try {
        mkdirSync4(undoDir(), { recursive: true });
        const tmp = `${dest}.${process.pid}.tmp`;
        writeFileSync4(tmp, params.beforeText, "utf8");
        copyFileSync2(tmp, dest);
        try {
          unlinkSync(tmp);
        } catch {}
        entry.undoFile = name;
      } catch {
        entry.undoFile = null;
      }
    }
  }
  append(changeLogPath(), entry);
  return entry;
}
function append(file, record) {
  try {
    mkdirSync4(dirname6(file), { recursive: true });
    appendFileSync2(file, JSON.stringify(record) + `
`, "utf8");
  } catch {}
}
function displayPath(abs, cwd) {
  try {
    const rel = relative(resolve6(cwd), abs);
    if (rel && !rel.startsWith("..") && !isAbsolute3(rel))
      return rel.replace(/\\/g, "/");
  } catch {}
  return abs;
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
function changeStoreError(p) {
  return `ERROR: AUDIT TRAIL PROTECTED — ${p} is the change log or its undo store. The agent cannot rewrite its own record of what it changed; that would make /diff and /revert worthless.`;
}
async function logChange(tool, p, ctx, before, after, note) {
  try {
    const entry = recordChange({ tool, path: p, cwd: ctx.cwd, beforeText: before, afterText: after, note });
    return `recorded in this session's change log — /diff to review, /revert to undo`;
  } catch (err) {
    return `WARNING: wrote the file but could not record it in the change log (${err?.message ?? err}) — /revert will not cover it`;
  }
}
async function preWriteNote(p, content) {
  if (isProtectedFile(p))
    return { ok: false, note: protectedError(p) };
  if (isChangeStorePath(p))
    return { ok: false, note: changeStoreError(p) };
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
    const p = args.path ? resolve4(String(args.path), ctx) : ctx.cwd;
    const denied = pathDenied(p, ctx);
    if (denied)
      return denied;
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
          const st = statSync2(join8(p, e.name));
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
    const p = resolve4(String(args.path), ctx);
    const denied = pathDenied(p, ctx);
    if (denied)
      return denied;
    if (!await fileExists(p))
      return `ERROR: file not found: ${p}`;
    const text = await fileText(p);
    const lines = text.split(`
`);
    const totalLines = lines.length;
    const offset = Math.max(1, Number(args.offset ?? 1) || 1);
    if (offset > totalLines)
      return `(file has ${totalLines} line(s); offset ${offset} is past the end)`;
    const limit = Math.max(0, Number(args.limit ?? 2000) || 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const shown = slice.length;
    const note = shown < limit && shown < totalLines - offset + 1 ? "" : "";
    const out = slice.map((l, i) => `${offset + i}: ${l}`).join(`
`);
    return shown < totalLines - offset + 1 && limit > 0 ? out + `
...(${totalLines - offset + 1 - shown} more line(s) not shown)` : out;
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
    const p = resolve4(String(args.path), ctx);
    const denied = pathDenied(p, ctx);
    if (denied)
      return denied;
    const content = String(args.content ?? "");
    const guard = await preWriteNote(p, content);
    if (!guard.ok)
      return guard.note;
    const before = await fileExists(p) ? await fileText(p) : null;
    mkdirSync5(dirname7(p), { recursive: true });
    await writeFileAsync(p, content, "utf8");
    const trail = await logChange("write_file", p, ctx, before, content, before === null ? "created" : `overwrote ${before.length} bytes`);
    return `Wrote ${content.length} bytes to ${p}
${trail}${guard.note ? `
` + guard.note : ""}`;
  }
});
registerTool({
  definition: {
    type: "function",
    function: {
      name: "edit_file",
      description: "Perform an exact string replacement in a file. Use to modify part of a file without rewriting the whole thing. By default replaces only the first occurrence; set replaceAll to true to replace every occurrence.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          oldString: { type: "string", description: "The exact text to find and replace" },
          newString: { type: "string", description: "The replacement text" },
          replaceAll: { type: "boolean", description: "When true, replace every occurrence (default: false — only first)" }
        },
        required: ["path", "oldString", "newString"]
      }
    }
  },
  async run(args, ctx) {
    if (ctx.planPhase)
      return `BLOCKED IN PLAN MODE: edit_file is disabled while investigating. Describe the exact change in your PLAN instead; the human approves before any file is touched.`;
    const p = resolve4(String(args.path), ctx);
    const denied = pathDenied(p, ctx);
    if (denied)
      return denied;
    const oldString = String(args.oldString ?? "");
    const newString = String(args.newString ?? "");
    const replaceAll = Boolean(args.replaceAll);
    if (!await fileExists(p))
      return `ERROR: file not found: ${p}`;
    if (isProtectedFile(p))
      return protectedError(p);
    if (isChangeStorePath(p))
      return changeStoreError(p);
    const text = await fileText(p);
    if (!oldString)
      return `ERROR: oldString cannot be empty`;
    const count = text.split(oldString).length - 1;
    if (count === 0)
      return `ERROR: oldString not found in file`;
    let updated;
    if (replaceAll) {
      updated = text.split(oldString).join(newString);
    } else {
      if (count > 1)
        return `ERROR: found ${count} matches; provide more surrounding context (oldString must be unique) or set replaceAll=true to replace all`;
      updated = text.replace(oldString, newString);
    }
    await writeFileAsync(p, updated, "utf8");
    const replaced = replaceAll ? count : 1;
    const note = isSelfFile(p) ? auditSelfEdit("edit_file", p, text, updated, `replaced ${replaced} occurrence${replaced > 1 ? "s" : ""}`) : "";
    const trail = await logChange("edit_file", p, ctx, text, updated, `replaced ${replaced} occurrence${replaced > 1 ? "s" : ""}`);
    return `Edited ${p}: replaced ${replaced} occurrence${replaced > 1 ? "s" : ""}
${trail}${note ? `
` + note : ""}`;
  }
});

// src/tools/glob.ts
import { opendir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join as join9 } from "node:path";
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
          const childAbs = join9(dir, e.name);
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
          await recurse(remaining, join9(dir, e.name), childRel);
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
          await recurse(remaining.slice(1), join9(dir, e.name), childRel);
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
function pageSize() {
  return numberSetting("maxSearchResults", MAX_RESULTS, 1);
}
registerTool({
  definition: {
    type: "function",
    function: {
      name: "glob",
      description: "List files matching a glob pattern (e.g. **/*.ts, src/**). Returns matching file paths, sorted. Results are paged: when more than `limit` match, the output says so and gives the `offset` to pass for the next page.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to search" },
          cwd: { type: "string", description: "Directory to search in (optional, defaults to workspace)" },
          limit: { type: "number", description: `Max results to return (optional, default ${MAX_RESULTS})` },
          offset: { type: "number", description: "Skip this many matches before returning results (optional, default 0). Use it to page through a truncated result set." }
        },
        required: ["pattern"]
      }
    }
  },
  async run(args, ctx) {
    const pattern = String(args.pattern ?? "");
    const dir = args.cwd ? String(args.cwd) : ctx.cwd;
    const denied = pathDenied(dir, ctx);
    if (denied)
      return denied;
    const limit = Math.max(1, Number(args.limit ?? pageSize()) || pageSize());
    const offset = Math.max(0, Number(args.offset ?? 0) || 0);
    let matches;
    try {
      matches = await globScan(pattern, { cwd: dir, onlyFiles: true, maxResults: MAX_SCANNED });
    } catch (err) {
      return `ERROR: glob failed: ${err?.message ?? String(err)}`;
    }
    matches.sort();
    const total = matches.length;
    const sliced = matches.slice(offset, offset + limit);
    if (!sliced.length) {
      return total === 0 ? "(no matches)" : `(no matches at offset ${offset}; ${total} total match${total === 1 ? "" : "es"} — you paged past the end)`;
    }
    let out = sliced.join(`
`);
    const next = offset + sliced.length;
    if (next < total) {
      out += `
[${next} of ${total} matches shown — pass offset: ${next} for the next page]`;
    } else {
      out += `
[${total} match${total === 1 ? "" : "es"} total]`;
    }
    return out;
  }
});
registerTool({
  definition: {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regex. Returns file paths and line numbers of matches. Results are paged: when more than `limit` match, the output says so and gives the `offset` to pass for the next page. Narrow the pattern or `include` glob instead of paging when you can.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          include: { type: "string", description: "File glob to filter (e.g. *.ts) (optional)" },
          path: { type: "string", description: "Directory to search (optional, defaults to workspace)" },
          timeout: { type: "number", description: "Timeout in milliseconds (optional, default 60000)" },
          limit: { type: "number", description: `Max results to return (optional, default ${MAX_RESULTS})` },
          offset: { type: "number", description: "Skip this many matches before returning results (optional, default 0). Use it to page through a truncated result set." }
        },
        required: ["pattern"]
      }
    }
  },
  async run(args, ctx) {
    const pattern = String(args.pattern ?? "");
    const dir = args.path ? String(args.path) : ctx.cwd;
    const denied = pathDenied(dir, ctx);
    if (denied)
      return denied;
    const include = args.include ? String(args.include) : "*";
    const timeout = Math.max(0, Number(args.timeout ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    const limit = Math.max(1, Number(args.limit ?? pageSize()) || pageSize());
    const offset = Math.max(0, Number(args.offset ?? 0) || 0);
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
    const total = lines.length;
    const sliced = lines.slice(offset, offset + limit);
    if (res.timedOut) {
      return sliced.join(`
`) + `
[killed: timed out after ${timeout} ms — this is a partial result set, not the whole match list]`;
    }
    if (res.aborted)
      return sliced.join(`
`) + `
[aborted]`;
    if (total === 0) {
      const err = res.stderr.trim();
      return err ? `ERROR: ${err}` : "(no matches)";
    }
    if (!sliced.length) {
      return `(no matches at offset ${offset}; ${total} total match${total === 1 ? "" : "es"} — you paged past the end)`;
    }
    let out = sliced.join(`
`);
    const next = offset + sliced.length;
    out += next < total ? `
[${next} of ${total} matches shown — pass offset: ${next} for the next page, or narrow the pattern]` : `
[${total} match${total === 1 ? "" : "es"} total]`;
    return out;
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
    if (deps.autoApproveExceptDestructive !== false) {
      if (name === "bash") {
        const why = bannedReason(String(args.command ?? ""));
        if (why) {
          log(deps, `  [[auto-run policy]] blocked ${name}: ${why}`);
          return false;
        }
      }
      const mutating = {
        git_commit: "commits changes",
        git_checkout_branch: "switches branches",
        git_push_ff: "pushes to a remote",
        env_set: "writes to .env",
        write_file: "writes files",
        edit_file: "edits files"
      };
      const why = mutating[name];
      if (why && deps.autoApproveMutating === false) {
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
      toolCtx: {
        cwd: task.cwd,
        signal,
        permissions: resolvePermissions(deps.permissions ?? { permissions: { filesystem: "workspace", exposeSecrets: false } }, task.cwd)
      },
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
    log(deps, `✅ [${task.id}] done in ${result.steps} step(s), ${result.toolCalls} tool call(s)`);
    return done;
  } catch (err) {
    const msg = err?.message ?? String(err);
    const existingAttempts = claimed.attempts ?? 0;
    const nextAttempts = existingAttempts + 1;
    if (nextAttempts >= 5) {
      const failed = markTaskFailed(task.id, msg, nextAttempts);
      log(deps, `✘ [${task.id}] failed (attempt ${nextAttempts}/5): ${msg}`);
      return failed ?? claimed;
    }
    const backoffMs = Math.min(300000, 30000 * Math.pow(2, nextAttempts - 1));
    const retried = markTaskRetry(task.id, nextAttempts);
    log(deps, `↻ [${task.id}] failed (attempt ${nextAttempts}/5) — will retry in ${(backoffMs / 1000).toFixed(0)}s`);
    return retried ?? claimed;
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
    return homedir7();
  if (p.startsWith("~/"))
    return join10(homedir7(), p.slice(2));
  return p;
}
var PID_FILE = join10(homedir7(), ".vibecoder", "queue-daemon.pid");
function readPid() {
  try {
    const s = readFileSync7(PID_FILE, "utf8").trim();
    const pid = Number(s);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
function writePid() {
  mkdirSync6(join10(homedir7(), ".vibecoder"), { recursive: true });
  writeFileSync5(PID_FILE, String(process.pid));
}
function removePid() {
  try {
    unlinkSync2(PID_FILE);
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
  mkdirSync6(logPath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  return (line) => {
    const text = `[${ts()}] ${line}
`;
    writeFileSync5(logPath, text, { flag: "a" });
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
  const logFile = rawLogFile ? expandHome2(rawLogFile) : join10(homedir7(), ".vibecoder", "queue-daemon.log");
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
    const tasks = JSON.parse(readFileSync7(queueFile(), "utf8"));
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
