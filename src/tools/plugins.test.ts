// Plugin loading: discovery (config entry, project package.json, config-dir
// plugins/), the schema lock applied before registration, failure isolation
// (a broken plugin reports, never crashes startup), and the off switch.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlugins } from "./plugins";
import { executeTool, registerTool, type ToolContext } from "./registry";

let dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vc-plugins-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const ctx: ToolContext = { cwd: process.cwd() };

function writePlugin(dir: string, file: string, source: string): string {
  const p = join(dir, file);
  writeFileSync(p, source, "utf8");
  return p;
}

const OK_TOOL = `export const tools = [
  {
    definition: {
      type: "function",
      function: {
        name: "plug_probe",
        description: "a loaded plugin tool",
        parameters: { type: "object", properties: { x: { type: "string" } } },
      },
    },
    async run(args) { return "plugin says " + (args.x ?? "?"); },
  },
];`;

describe("loadPlugins", () => {
  test("loads a config-dir plugin and its tool runs", async () => {
    const configDir = newDir();
    mkdirSync(join(configDir, "plugins"));
    writePlugin(join(configDir, "plugins"), "one.mjs", OK_TOOL);
    const report = await loadPlugins({ cwd: newDir(), configDir });
    expect(report.errors).toEqual([]);
    expect(report.loaded).toHaveLength(1);
    expect(report.loaded[0].tools).toEqual(["plug_probe"]);
    expect(await executeTool("plug_probe", { x: "hi" }, ctx)).toBe("plugin says hi");
  });

  test("loads a package dir via vibecoder.extension / main", async () => {
    const configDir = newDir(); // empty: no config-dir plugins
    const cwd = newDir();
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "demo", "vibecoder.extension": "./ext/plug" }),
      "utf8",
    );
    const pkgDir = join(cwd, "ext", "plug");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "plug", main: "index.mjs" }), "utf8");
    writePlugin(pkgDir, "index.mjs", OK_TOOL.replace("plug_probe", "plug_dir"));
    const report = await loadPlugins({ cwd, configDir });
    expect(report.errors).toEqual([]);
    expect(report.loaded[0].tools).toEqual(["plug_dir"]);
    expect(await executeTool("plug_dir", { x: "d" }, ctx)).toBe("plugin says d");
  });

  test("loads explicit config.plugins entries (cwd-relative)", async () => {
    const cwd = newDir();
    writePlugin(cwd, "cfgplug.mjs", OK_TOOL.replace("plug_probe", "plug_cfg"));
    const report = await loadPlugins({ cwd, configDir: newDir(), plugins: ["cfgplug.mjs"] });
    expect(report.errors).toEqual([]);
    expect(report.loaded[0].tools).toEqual(["plug_cfg"]);
  });

  test("a schema-lock violation is reported and never registered", async () => {
    const configDir = newDir();
    mkdirSync(join(configDir, "plugins"));
    writePlugin(join(configDir, "plugins"), "bad.mjs", OK_TOOL.replace("plug_probe", "Bad_Name"));
    const report = await loadPlugins({ cwd: newDir(), configDir });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].error).toContain("schema lock");
    expect(() => executeTool("Bad_Name", {}, ctx)).toThrow(/Unknown tool/);
  });

  test("a duplicate name is reported; the existing tool is untouched", async () => {
    registerTool({
      definition: { type: "function", function: { name: "plug_taken", description: "original", parameters: { type: "object", properties: {} } } },
      run: async () => "original tool",
    });
    const configDir = newDir();
    mkdirSync(join(configDir, "plugins"));
    writePlugin(join(configDir, "plugins"), "dupe.mjs", OK_TOOL.replace("plug_probe", "plug_taken"));
    const report = await loadPlugins({ cwd: newDir(), configDir });
    expect(report.errors.map((e) => e.error).join(" ")).toContain("Duplicate tool name");
    expect(await executeTool("plug_taken", {}, ctx)).toBe("original tool");
  });

  test("a plugin that fails to import (or exports nothing) degrades to an error", async () => {
    const configDir = newDir();
    mkdirSync(join(configDir, "plugins"));
    writePlugin(join(configDir, "plugins"), "boom.mjs", `throw new Error("plugin startup exploded");`);
    writePlugin(join(configDir, "plugins"), "empty.mjs", `export const hello = 1;`);
    const report = await loadPlugins({ cwd: newDir(), configDir });
    expect(report.loaded).toHaveLength(0);
    expect(report.errors).toHaveLength(2);
    expect(report.errors.map((e) => e.error).join(" ")).toContain("plugin startup exploded");
    expect(report.errors.map((e) => e.error).join(" ")).toContain("exports no tools");
  });

  test("VIBECODER_NO_PLUGINS=1 loads nothing at all", async () => {
    const configDir = newDir();
    mkdirSync(join(configDir, "plugins"));
    writePlugin(join(configDir, "plugins"), "one.mjs", OK_TOOL.replace("plug_probe", "plug_off"));
    const report = await loadPlugins({ cwd: newDir(), configDir, env: { VIBECODER_NO_PLUGINS: "1" } });
    expect(report.loaded).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(() => executeTool("plug_off", {}, ctx)).toThrow(/Unknown tool/);
  });
});
