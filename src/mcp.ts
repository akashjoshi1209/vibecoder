// MCP adapter (plan item 8, step 3): two directions, zero dependencies.
//
//   `vibecoder mcp`   — serve every registered tool over MCP stdio: a
//                       newline-delimited JSON-RPC 2.0 loop (initialize,
//                       tools/list, tools/call, ping). Any MCP host (Claude
//                       Desktop, an orchestrator, another agent) can drive
//                       vibecoder's tools as a server.
//   `mcpServers` in   — spawn local MCP servers at startup and register their
//   config.json         tools namespaced as `mcp_<server>_<tool>`, each
//                       carrying `[mcp:<server>]` provenance in its
//                       description.
//
// The stdio framing is the MCP standard: one JSON object per line, both ways.
// Proxied tools obey the same rules as built-ins: schema-lock registration,
// plan-mode refusal, permission-model checks inside the tools themselves, and
// unattended posture (a tool that asks for a human reports that, since a
// remote host has no vibecoder prompter). Servers are declared explicitly in
// config and run with this process's privileges — trusted like plugins; see
// THREAT_MODEL.md. VIBECODER_NO_MCP=1 disables connecting them.
import { loadConfig } from "./config";
import type { McpServerSpec, RootConfig } from "./llm/client";
import { resolvePermissions } from "./permissions";
import { readPackageJson } from "./paths";
import { executeTool, registerTool, type ToolContext } from "./tools/registry";
import { TOOL_NAME_RE } from "./tools/schema";
import { listTools } from "./tools/registry";
import { noPrompterMessage, isApprovalRequired } from "./tools/approval";
import { spawnSession, type SpawnSession } from "./tools/proc";

/** Protocol version we speak; we echo the client's on initialize so any
 *  conforming host can negotiate down. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const MAX_PROXY_OUTPUT = 30_000;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── server half ─────────────────────────────────────────────────────────────

export interface McpServerDeps {
  /** What tools/call executes with: cwd + permission model (no prompter — a
   *  remote host gets explicit refusals, never a hidden prompt). */
  ctx: ToolContext;
  name?: string;
  version?: string;
}

export function createMcpServer(deps: McpServerDeps): { handle(raw: string): Promise<string | null> } {
  const name = deps.name ?? "vibecoder";
  const version = deps.version ?? readPackageJson()?.version ?? "dev";

  return {
    async handle(raw: string): Promise<string | null> {
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(raw) as JsonRpcRequest;
      } catch {
        return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      if (!msg || typeof msg !== "object") {
        return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      }
      // No id → notification (notifications/initialized, notifications/cancelled, …): no reply.
      if (msg.id === undefined || msg.id === null) return null;
      const id = msg.id;
      const ok = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
      const fail = (code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

      switch (msg.method) {
        case "initialize": {
          const params = (msg.params ?? {}) as { protocolVersion?: string };
          return ok({
            protocolVersion: params.protocolVersion ?? MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
          });
        }
        case "ping":
          return ok({});
        case "tools/list":
          return ok({
            tools: listTools().map((t) => ({
              name: t.function.name,
              description: t.function.description,
              inputSchema: t.function.parameters,
            })),
          });
        case "tools/call": {
          const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
          const toolName = typeof params.name === "string" ? params.name : "";
          if (!toolName || !listTools().some((t) => t.function.name === toolName)) {
            return fail(-32602, `unknown tool ${JSON.stringify(toolName)}`);
          }
          const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
            ? params.arguments
            : {}) as Record<string, unknown>;
          try {
            const text = await executeTool(toolName, args, deps.ctx);
            const isError = /^(ERROR|BLOCKED)/.test(text);
            return ok({ content: [{ type: "text", text }], isError });
          } catch (err) {
            // Approval request: the server has no prompter attached.
            const text = isApprovalRequired(err)
              ? noPrompterMessage(toolName, err.reason)
              : errorMessage(err);
            return ok({ content: [{ type: "text", text }], isError: true });
          }
        }
        default:
          return fail(-32601, `method not found: ${String(msg.method)}`);
      }
    },
  };
}

/** Serve MCP on stdio until input ends. Responses preserve request order even
 *  when a tools/call is still running when the next line arrives. */
export async function serveMcpStdio(
  deps: McpServerDeps,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const server = createMcpServer(deps);
  let buf = "";
  let queue: Promise<void> = Promise.resolve();
  await new Promise<void>((resolve) => {
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        queue = queue.then(async () => {
          const resp = await server.handle(line);
          if (resp) output.write(resp + "\n");
        });
      }
    };
    input.on("data", onData);
    const done = () => {
      // Drain answers to requests that already arrived, then stop.
      void queue.then(() => resolve());
    };
    input.on("end", done);
    input.on("close", done);
  });
}

/** `vibecoder mcp`: load config (so permissions match the interactive model)
 *  and serve the full tool registry over stdio. Returns the exit code. */
export async function runMcpCli(): Promise<number> {
  const config = await loadConfig();
  const cwd = process.cwd();
  const ctx: ToolContext = { cwd, permissions: resolvePermissions(config, cwd) };
  await serveMcpStdio({ ctx, version: readPackageJson()?.version ?? "dev" });
  return 0;
}

// ── client half ─────────────────────────────────────────────────────────────

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClient {
  name: string;
  tools: McpToolInfo[];
  /** Call one of the server's tools; resolves its text, throws on protocol or
   *  server failure (including `isError` results, prefixed by the caller). */
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  close(): void;
}

const connectedClients: McpClient[] = [];

/** `mcp_<server>_<tool>`, sanitized into the locked name shape. */
export function mcpProxyName(server: string, tool: string): string | null {
  const san = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const n = `mcp_${san(server)}_${san(tool)}`.slice(0, 64);
  return TOOL_NAME_RE.test(n) ? n : null;
}

function normalizeInputSchema(s: unknown): Record<string, unknown> {
  if (s && typeof s === "object" && !Array.isArray(s)) {
    const o = s as Record<string, unknown>;
    return o.type === "object" ? o : { ...o, type: "object" };
  }
  return { type: "object", properties: {} };
}

/** Spawn one MCP stdio server and complete the handshake. Throws on any
 *  handshake failure (bad JSON, exit, timeout) after killing the child. */
export async function connectMcpServer(
  name: string,
  spec: McpServerSpec,
  opts: { cwd?: string; version?: string; handshakeTimeoutMs?: number } = {},
): Promise<McpClient> {
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
  const callTimeoutMs = spec.timeoutMs ?? 30_000;
  const stderrTail: string[] = [];
  const session: SpawnSession = spawnSession({
    cmd: [spec.command, ...(spec.args ?? [])],
    cwd: opts.cwd,
    env: { ...process.env, ...spec.env },
    onStderr: (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 20) stderrTail.shift();
    },
  });

  let nextId = 1;
  const pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  session.onLine((line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON — a server printing diagnostics on stdout; ignore
    }
    if (msg === null || typeof msg !== "object" || msg.id === undefined || msg.id === null) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`MCP "${name}": ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  });
  session.onExit(() => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server "${name}" exited${stderrTail.length ? ` — last stderr: ${stderrTail[stderrTail.length - 1]}` : ""}`));
    }
    pending.clear();
  });

  const request = (method: string, params: unknown, timeoutMs: number): Promise<any> =>
    new Promise((resolvePromise, rejectPromise) => {
      if (!session.alive) {
        rejectPromise(new Error(`MCP server "${name}" is not running${stderrTail.length ? ` — ${stderrTail[stderrTail.length - 1]}` : ""}`));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`MCP "${name}": ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      if (!session.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }))) {
        pending.delete(id);
        clearTimeout(timer);
        rejectPromise(new Error(`MCP server "${name}" closed its stdin`));
      }
    });

  try {
    await request(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "vibecoder", version: opts.version ?? readPackageJson()?.version ?? "dev" } },
      handshakeTimeoutMs,
    );
    session.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const list = (await request("tools/list", {}, handshakeTimeoutMs)) as { tools?: unknown } | undefined;
    const tools: McpToolInfo[] = Array.isArray(list?.tools)
      ? (list!.tools as McpToolInfo[]).filter((t) => t && typeof t.name === "string")
      : [];

    const client: McpClient = {
      name,
      tools,
      async call(tool, args, signal) {
        if (signal?.aborted) throw new Error("aborted");
        const result = await request("tools/call", { name: tool, arguments: args }, callTimeoutMs);
        const content = Array.isArray((result as any)?.content) ? ((result as any).content as Array<{ type?: string; text?: string }>) : [];
        const text = content
          .filter((c) => c && c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("");
        const body = text || "(no text content)";
        if ((result as any)?.isError && !/^(ERROR|BLOCKED)/.test(body)) return `ERROR: ${body}`;
        return body;
      },
      close() {
        session.close();
      },
    };
    connectedClients.push(client);
    return client;
  } catch (err) {
    session.close();
    throw err;
  }
}

/** Register a connected client's tools as namespaced proxies. One bad tool
 *  (name collision, schema-lock failure) is an error entry, not a lost server. */
export function registerMcpClient(client: McpClient): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];
  for (const t of client.tools) {
    const proxyName = mcpProxyName(client.name, t.name);
    if (!proxyName) {
      errors.push(`${client.name}.${t.name}: unusable tool name`);
      continue;
    }
    try {
      registerTool({
        definition: {
          type: "function",
          function: {
            name: proxyName,
            description: `[mcp:${client.name}] ${String(t.description ?? t.name).trim()} (proxied via MCP; state it may act outside this workspace)`,
            parameters: normalizeInputSchema(t.inputSchema),
          },
        },
        cost: { expensive: false },
        run: async (args, ctx) => {
          // Plan mode refuses every mutation-bearing surface it can see;
          // a remote tool is at least as capable as bash.
          if (ctx.planPhase) {
            return "BLOCKED IN PLAN MODE (read-only): MCP tools can change state outside this workspace — describe it in the plan instead.";
          }
          try {
            const out = await client.call(t.name, args, ctx.signal);
            return out.length > MAX_PROXY_OUTPUT
              ? out.slice(0, MAX_PROXY_OUTPUT) + `\n… (truncated ${out.length - MAX_PROXY_OUTPUT} chars)`
              : out;
          } catch (err) {
            return `ERROR: ${errorMessage(err)}`;
          }
        },
      });
      registered.push(proxyName);
    } catch (err) {
      errors.push(`${client.name}.${t.name}: ${errorMessage(err)}`);
    }
  }
  return { registered, errors };
}

export interface McpConnectReport {
  loaded: Array<{ name: string; tools: string[] }>;
  errors: Array<{ source: string; error: string }>;
}

/** Connect every configured MCP server and register its tools. Never throws:
 *  an unreachable server degrades to an error line so startup survives. */
export async function connectConfigMcpServers(
  config: Pick<RootConfig, "mcpServers">,
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<McpConnectReport> {
  const report: McpConnectReport = { loaded: [], errors: [] };
  const entries = Object.entries(config.mcpServers ?? {});
  if (!entries.length) return report;
  if ((opts.env ?? process.env).VIBECODER_NO_MCP === "1") return report;
  for (const [name, spec] of entries) {
    try {
      const client = await connectMcpServer(name, spec, { cwd: opts.cwd });
      const reg = registerMcpClient(client);
      report.loaded.push({ name, tools: reg.registered });
      for (const e of reg.errors) report.errors.push({ source: `mcp:${name}`, error: e });
    } catch (err) {
      report.errors.push({ source: `mcp:${name}`, error: errorMessage(err) });
    }
  }
  return report;
}

/** Kill every connected MCP server (process exit, reload). Idempotent. */
export function closeAllMcpClients(): void {
  while (connectedClients.length) {
    const c = connectedClients.pop();
    try {
      c?.close();
    } catch {
      /* already dead */
    }
  }
}
