import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTool, type ToolContext } from "./registry";
import { parseEnv, formatEnv } from "./env";

import "./env";

const NL = "\n";
const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "vc-env-test-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("parseEnv", () => {
  test("parses plain key=value", () => {
    expect(parseEnv("A=1" + NL + "B=2")).toEqual({ A: "1", B: "2" });
  });

  test("handles CRLF line endings", () => {
    // This is the bug: splitting on \n alone left a trailing \r on every
    // value, so on a Windows-authored .env every key read back as empty.
    expect(parseEnv("A=1\r" + NL + "B=2\r" + NL)).toEqual({ A: "1", B: "2" });
  });

  test("strips surrounding double quotes", () => {
    expect(parseEnv('A="hello world"')).toEqual({ A: "hello world" });
  });

  test("strips surrounding single quotes", () => {
    expect(parseEnv("A='hello world'")).toEqual({ A: "hello world" });
  });

  test("unescapes JSON-style escapes in double-quoted values", () => {
    expect(parseEnv('A="say \\"hi\\""')).toEqual({ A: 'say "hi"' });
  });

  test("keeps a value containing a literal quote", () => {
    // Masking used to expose the quote character as part of the value.
    expect(parseEnv('A="quoted"')).toEqual({ A: "quoted" });
  });

  test("ignores comments and blank lines", () => {
    expect(parseEnv("# note" + NL + NL + "A=1" + NL)).toEqual({ A: "1" });
  });

  test("accepts export prefix", () => {
    expect(parseEnv("export A=1")).toEqual({ A: "1" });
  });

  test("keeps an inline comment-free value containing #", () => {
    expect(parseEnv("A=abc#123")).toEqual({ A: "abc#123" });
  });

  test("handles an empty value", () => {
    expect(parseEnv("A=")).toEqual({ A: "" });
  });
});

describe("formatEnv", () => {
  test("round-trips through parseEnv", () => {
    const dict = {
      PLAIN: "abc",
      SPACED: "a b",
      QUOTED: 'say "hi"',
      DOLLAR: "a$b",
      HASH: "a#b",
      EMPTY: "",
    };
    expect(parseEnv(formatEnv(dict))).toEqual(dict);
  });

  test("leaves simple values unquoted so other dotenv readers work", () => {
    expect(formatEnv({ A: "plain" })).toBe("A=plain\n");
  });

  test("ends with a newline", () => {
    expect(formatEnv({ A: "1" }).endsWith(NL)).toBe(true);
  });
});

describe("env tools", () => {
  test("env_get reads a CRLF file correctly", async () => {
    const d = scratch();
    const envFile = join(d, ".env");
    writeFileSync(envFile, "CRLF_KEY=value1\r\nOTHER=value2\r\n");
    process.env.VIBECODER_ENV_FILE = envFile;
    const ctx: ToolContext = { cwd: d };
    const res = await executeTool("env_get", { key: "CRLF_KEY" }, ctx);
    expect(res).toContain("set");
    const list = await executeTool("env_list", {}, ctx);
    expect(list).toContain("CRLF_KEY");
    expect(list).toContain("OTHER");
    delete process.env.VIBECODER_ENV_FILE;
  });

  test("env_get masks a value", async () => {
    const d = scratch();
    const envFile = join(d, ".env");
    writeFileSync(envFile, "TEST_KEY=super-secret-value" + NL);
    process.env.VIBECODER_ENV_FILE = envFile;
    const ctx: ToolContext = { cwd: d };
    const res = await executeTool("env_get", { key: "TEST_KEY" }, ctx);
    expect(res).not.toContain("super-secret-value");
    expect(res).toContain("set");
    delete process.env.VIBECODER_ENV_FILE;
  });

  test("env_set is refused in plan mode", async () => {
    const d = scratch();
    const envFile = join(d, ".env");
    writeFileSync(envFile, "EXISTING=keepme" + NL);
    process.env.VIBECODER_ENV_FILE = envFile;
    const ctx: ToolContext = { cwd: d, planPhase: true };
    const res = await executeTool("env_set", { key: "NEW", value: "x" }, ctx);
    expect(res).toContain("BLOCKED IN PLAN MODE");
    // The file must be untouched.
    expect(readFileSync(envFile, "utf8")).toBe("EXISTING=keepme" + NL);
    delete process.env.VIBECODER_ENV_FILE;
  });

  test("env_set preserves unrelated keys", async () => {
    const d = scratch();
    const envFile = join(d, ".env");
    writeFileSync(envFile, "A=1" + NL + "B=2" + NL);
    process.env.VIBECODER_ENV_FILE = envFile;
    const ctx: ToolContext = { cwd: d };
    await executeTool("env_set", { key: "C", value: "3" }, ctx);
    expect(parseEnv(readFileSync(envFile, "utf8"))).toEqual({ A: "1", B: "2", C: "3" });
    delete process.env.VIBECODER_ENV_FILE;
  });

  test("env_set updates an existing key without dropping others", async () => {
    const d = scratch();
    const envFile = join(d, ".env");
    writeFileSync(envFile, "A=1" + NL + "B=2" + NL);
    process.env.VIBECODER_ENV_FILE = envFile;
    const ctx: ToolContext = { cwd: d };
    await executeTool("env_set", { key: "A", value: "99" }, ctx);
    expect(parseEnv(readFileSync(envFile, "utf8"))).toEqual({ A: "99", B: "2" });
    delete process.env.VIBECODER_ENV_FILE;
  });

  test("env_set rejects an invalid variable name", async () => {
    const d = scratch();
    const envFile = join(d, ".env");
    writeFileSync(envFile, "");
    process.env.VIBECODER_ENV_FILE = envFile;
    const ctx: ToolContext = { cwd: d };
    const res = await executeTool("env_set", { key: "BAD-NAME", value: "x" }, ctx);
    expect(res).toContain("not a valid environment variable name");
    delete process.env.VIBECODER_ENV_FILE;
  });

  test("env_set leaves no temp file behind", async () => {
    const d = scratch();
    const envFile = join(d, ".env");
    writeFileSync(envFile, "A=1" + NL);
    process.env.VIBECODER_ENV_FILE = envFile;
    const ctx: ToolContext = { cwd: d };
    await executeTool("env_set", { key: "B", value: "2" }, ctx);
    expect(existsSync(envFile + ".tmp")).toBe(false);
    delete process.env.VIBECODER_ENV_FILE;
  });
});
