// The schema lock: what registerTool refuses, and the cost/trace hooks that
// ride alongside it. Every registration path — built-in, plugin, MCP proxy —
// funnels through validateTool(), so these rules are the contract external
// tool authors code against (TOOL_SCHEMA_VERSION).
import { describe, expect, test } from "bun:test";
import { executeTool, registerTool, type Tool, type ToolContext } from "./registry";
import { TOOL_NAME_RE, TOOL_SCHEMA_VERSION, validateTool } from "./schema";
import type { ToolTraceEvent } from "./schema";

const ctx: ToolContext = { cwd: process.cwd() };

function makeTool(over: Partial<Tool> & { name?: string; description?: string; parameters?: Record<string, unknown> } = {}): Tool {
  const { name = "schema_probe", description = "probe", parameters, ...rest } = over as Record<string, unknown> & { name?: string };
  return {
    definition: {
      type: "function",
      function: {
        name: name!,
        description: (description as string) ?? "",
        parameters: (parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
      },
    },
    ...(rest as object),
    run: (rest.run as Tool["run"]) ?? (async () => "ok"),
  } as Tool;
}

describe("validateTool (the lock)", () => {
  test("accepts a well-formed tool", () => {
    expect(validateTool(makeTool())).toEqual([]);
  });

  test("rejects bad names against the locked shape", () => {
    expect(TOOL_SCHEMA_VERSION).toBe(1);
    for (const bad of ["BadName", "1leading", "has-dash", "", "x".repeat(65), 42]) {
      const errs = validateTool(makeTool({ name: bad as string }));
      expect(errs.some((e) => e.includes("must match"))).toBe(true);
    }
    expect(TOOL_NAME_RE.test("mcp_faketest_echo_tool")).toBe(true);
  });

  test("rejects missing description, bad inputs, and missing run", () => {
    expect(validateTool(makeTool({ description: "   " }))[0]).toContain("description");
    expect(validateTool(makeTool({ parameters: { type: "string" } }))[0]).toContain('parameters.type must be "object"');
    expect(validateTool(makeTool({ parameters: { type: "object", properties: "nope" } }))[0]).toContain("properties must be an object");
    expect(validateTool({ definition: makeTool().definition }).join(" ")).toContain("tool.run must be a function");
    expect(validateTool(makeTool({ name: "schema_probe", onTrace: "nope" as never }))[0]).toContain("onTrace must be a function");
  });
});

describe("registerTool enforcement", () => {
  test("refuses a malformed tool with the schema lock message", () => {
    expect(() => registerTool(makeTool({ name: "Bad Tool" }))).toThrow(/schema lock/);
    expect(() => registerTool({ definition: makeTool().definition } as Tool)).toThrow(/schema lock/);
  });

  test("still refuses duplicates", () => {
    registerTool(makeTool({ name: "schema_dupe" }));
    expect(() => registerTool(makeTool({ name: "schema_dupe" }))).toThrow(/Duplicate tool name/);
  });
});

describe("onTrace hook", () => {
  const events: ToolTraceEvent[] = [];
  registerTool(
    makeTool({
      name: "schema_traced",
      description: "emits trace events",
      run: async (args) => {
        if (args.fail === true) throw new Error("hook probe exploded");
        if (args.refuse === true) return "ERROR: refused by probe";
        return "all good";
      },
      onTrace: (e) => events.push(e),
    }),
  );

  test("fires with ms and outcome on success, error strings and throws", async () => {
    events.length = 0;
    expect(await executeTool("schema_traced", {}, ctx)).toBe("all good");
    expect(events.at(-1)).toMatchObject({ tool: "schema_traced", ok: true });
    expect(events.at(-1)!.ms).toBeGreaterThanOrEqual(0);

    await executeTool("schema_traced", { refuse: true }, ctx);
    expect(events.at(-1)!.ok).toBe(false);

    expect(await executeTool("schema_traced", { fail: true }, ctx)).toContain("ERROR:");
    expect(events.at(-1)!.ok).toBe(false);
  });

  test("a hook that throws cannot break the call it traces", async () => {
    registerTool(
      makeTool({
        name: "schema_badhook",
        description: "hook throws",
        run: async () => "still works",
        onTrace: () => {
          throw new Error("trace boom");
        },
      }),
    );
    expect(await executeTool("schema_badhook", {}, ctx)).toBe("still works");
  });
});
