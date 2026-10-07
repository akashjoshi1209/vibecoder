// The MCP adapter: server dispatcher (initialize / tools/list / tools/call /
// errors / notifications), stdio framing with ordered responses, and the
// client half — handshake, namespaced proxy registration, plan-mode refusal,
// timeouts and teardown — against a real child process speaking the protocol.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import {
  MCP_PROTOCOL_VERSION,
  connectMcpServer,
  createMcpServer,
  mcpProxyName,
  registerMcpClient,
  serveMcpStdio,
} from "./mcp";
import { executeTool, listTools, registerTool, type ToolContext } from "./tools/registry";
import { ApprovalRequiredError } from "./tools/approval";

let dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vc-mcp-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const ctx: ToolContext = { cwd: process.cwd() };

registerTool({
  definition: {
    type: "function",
    function: {
      name: "mcp_probe",
      description: "probe for MCP server tests",
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, delay: { type: "number" } },
      },
    },
  },
  async run(args) {
    const delay = Number(args.delay ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (args.text === "boom") throw new Error("probe exploded");
    if (args.text === "approve") throw new ApprovalRequiredError("mcp_probe", "needs a human", args);
    return `probe:${args.text ?? ""}`;
  },
});

const server = createMcpServer({ ctx, name: "vibecoder-test", version: "9.9.9" });

function parse(line: string): any {
  return JSON.parse(line);
}

describe("MCP server dispatcher", () => {
  test("initialize negotiates and identifies", async () => {
    const res = parse(
      (await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })))!,
    );
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.capabilities.tools.listChanged).toBe(false);
    expect(res.result.serverInfo).toEqual({ name: "vibecoder-test", version: "9.9.9" });
    // Without a client version we speak ours.
    const res2 = parse((await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" })))!);
    expect(res2.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  test("tools/list exposes the locked registry with input schemas", async () => {
    const res = parse((await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })))!);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("mcp_probe");
    const probe = res.result.tools.find((t: any) => t.name === "mcp_probe");
    expect(probe.description).toBe("probe for MCP server tests");
    expect(probe.inputSchema.type).toBe("object");
  });

  test("tools/call returns content, and isError for failures and refusals", async () => {
    const ok = parse(
      (await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mcp_probe", arguments: { text: "hi" } } })))!,
    );
    expect(ok.result.isError).toBe(false);
    expect(ok.result.content[0]).toEqual({ type: "text", text: "probe:hi" });

    const failed = parse(
      (await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mcp_probe", arguments: { text: "boom" } } })))!,
    );
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0].text).toContain("probe exploded");

    // No prompter is attached to a server: an approval request is an explicit
    // refusal, never a hidden prompt and never a hang.
    const refused = parse(
      (await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "mcp_probe", arguments: { text: "approve" } } })))!,
    );
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("no approver");
  });

  test("protocol errors: unknown tool -32602, unknown method -32601, bad JSON -32700", async () => {
    const unknownTool = parse(
      (await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "not_here" } })))!,
    );
    expect(unknownTool.error.code).toBe(-32602);
    const unknownMethod = parse((await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "roots/list" })))!);
    expect(unknownMethod.error.code).toBe(-32601);
    const badJson = parse((await server.handle("{not json"))!);
    expect(badJson.error.code).toBe(-32700);
    expect(badJson.id).toBeNull();
  });

  test("notifications get no reply; ping answers", async () => {
    expect(await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    const pong = parse((await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })))!);
    expect(pong.result).toEqual({});
  });
});

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("MCP stdio framing", () => {
  test("answers lines in request order and exits when input ends", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (d) => {
      for (const l of d.toString().split("\n")) if (l.trim()) lines.push(l);
    });
    const served = serveMcpStdio({ ctx }, input, output);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    // A slow tools/call followed by ping: replies must preserve request order.
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp_probe", arguments: { text: "slow", delay: 80 } } }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) + "\n");
    await until(() => lines.length >= 3, "three responses");
    expect(lines.map((l) => parse(l).id)).toEqual([1, 2, 3]);
    input.end();
    await served;
  });
});

describe("MCP client", () => {
  const FAKE_SERVER = `
let buf = "";
const send = (id, result, error) =>
  process.stdout.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.id === null) continue;
    if (msg.method === "initialize") {
      send(msg.id, { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0.0.1" } });
    } else if (msg.method === "tools/list") {
      send(msg.id, { tools: [{ name: "echo_tool", description: "echoes back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
    } else if (msg.method === "tools/call") {
      const a = msg.params?.arguments ?? {};
      if (msg.params?.name !== "echo_tool") send(msg.id, null, { code: -32602, message: "unknown tool" });
      else if (a.text === "hang") { /* never answer: exercises the call timeout */ }
      else if (a.text === "fail") send(msg.id, { content: [{ type: "text", text: "ERROR: fake failure" }], isError: true });
      else send(msg.id, { content: [{ type: "text", text: "echo: " + (a.text ?? "") }], isError: false });
    } else if (msg.method === "ping") send(msg.id, {});
    else send(msg.id, null, { code: -32601, message: "no such method" });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

  function fakeServer(name: string): string {
    const d = newDir();
    const f = join(d, `${name}.mjs`);
    writeFileSync(f, FAKE_SERVER, "utf8");
    return f;
  }

  test("handshake, namespaced proxy registration, and calls end-to-end", async () => {
    const file = fakeServer("ok");
    const client = await connectMcpServer("faketest", { command: process.execPath, args: [file], timeoutMs: 5000 });
    expect(client.tools.map((t) => t.name)).toEqual(["echo_tool"]);
    expect(client.tools[0].description).toBe("echoes back");

    const reg = registerMcpClient(client);
    expect(reg.errors).toEqual([]);
    expect(reg.registered).toEqual(["mcp_faketest_echo_tool"]);

    // Provenance is visible in the model-facing description.
    const proxy = listTools().find((t) => t.function.name === "mcp_faketest_echo_tool");
    expect(proxy!.function.description).toContain("[mcp:faketest]");
    expect(proxy!.function.description).toContain("echoes back");

    expect(await executeTool("mcp_faketest_echo_tool", { text: "hi" }, ctx)).toBe("echo: hi");
    // isError results surface as ERROR-prefixed tool output.
    expect(await executeTool("mcp_faketest_echo_tool", { text: "fail" }, ctx)).toContain("ERROR: fake failure");
    // Plan mode refuses remote tools: they can mutate outside the workspace.
    expect(await executeTool("mcp_faketest_echo_tool", { text: "hi" }, { ...ctx, planPhase: true })).toContain("BLOCKED IN PLAN MODE");
    client.close();
  });

  test("a hung call times out as an error, never a hang", async () => {
    const file = fakeServer("hang");
    const client = await connectMcpServer("hangtest", { command: process.execPath, args: [file], timeoutMs: 400 });
    expect(registerMcpClient(client).registered).toEqual(["mcp_hangtest_echo_tool"]);
    const out = await executeTool(
      "mcp_hangtest_echo_tool",
      { text: "hang" },
      ctx,
    ).catch((e) => `threw: ${e}`);
    // Either the proxy caught the timeout (ERROR string) — the normal path.
    expect(out).toContain("timed out after 400ms");
    client.close();
  });

  test("a server that never starts fails the handshake and cleans up", async () => {
    await expect(
      connectMcpServer("dead", { command: "vibecoder-no-such-binary-xyz", timeoutMs: 1000 }, { handshakeTimeoutMs: 3000 }),
    ).rejects.toThrow();
  });
});

describe("mcpProxyName", () => {
  test("sanitizes into the locked name shape", () => {
    expect(mcpProxyName("My-Server", "do_thing")).toBe("mcp_my_server_do_thing");
    expect(mcpProxyName("s", "ÜBER_tool")).toBe("mcp_s_ber_tool");
    expect(mcpProxyName("s", "x")!.length).toBeLessThanOrEqual(64);
  });
});
