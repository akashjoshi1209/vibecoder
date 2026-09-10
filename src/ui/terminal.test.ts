import { describe, expect, test } from "bun:test";
import { KeyParser, displayWidth, wrapAnsi, wrapText } from "./terminal";

function events(bytes: number[], exp?: string) {
  // exp: optionally press Escape-then-suffix to test held ESC
  const p = new KeyParser();
  const out = p.feed(bytes);
  if (exp) {
    const held = p.finalize();
    return [...out, ...held];
  }
  return out;
}

describe("KeyParser", () => {
  test("single char", () => {
    expect(events([0x68, 0x69]).map((e) => e.kind)).toEqual(["char", "char"]);
  });

  test("enter / backspace / tab", () => {
    expect(events([0x0d]).map((e) => e.kind)).toEqual(["enter"]);
    expect(events([0x7f]).map((e) => e.kind)).toEqual(["backspace"]);
    expect(events([0x09]).map((e) => e.kind)).toEqual(["tab"]);
  });

  test("ctrl-c", () => {
    expect(events([0x03]).map((e) => e.kind)).toEqual(["ctrl-c"]);
  });

  test("arrow keys", () => {
    expect(events([0x1b, 0x5b, 0x41]).map((e) => e.kind)).toEqual(["up"]);
    expect(events([0x1b, 0x5b, 0x42]).map((e) => e.kind)).toEqual(["down"]);
    expect(events([0x1b, 0x5b, 0x43]).map((e) => e.kind)).toEqual(["right"]);
    expect(events([0x1b, 0x5b, 0x44]).map((e) => e.kind)).toEqual(["left"]);
  });

  test("ctrl+arrow", () => {
    expect(events([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x43]).map((e) => e.kind)).toEqual(["ctrl-right"]);
    expect(events([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x44]).map((e) => e.kind)).toEqual(["ctrl-left"]);
  });

  test("home / end / delete / pgup / pgdn", () => {
    expect(events([0x1b, 0x5b, 0x48]).map((e) => e.kind)).toEqual(["home"]);
    expect(events([0x1b, 0x5b, 0x46]).map((e) => e.kind)).toEqual(["end"]);
    expect(events([0x1b, 0x5b, 0x33, 0x7e]).map((e) => e.kind)).toEqual(["delete"]);
    expect(events([0x1b, 0x5b, 0x35, 0x7e]).map((e) => e.kind)).toEqual(["pageup"]);
    expect(events([0x1b, 0x5b, 0x36, 0x7e]).map((e) => e.kind)).toEqual(["pagedown"]);
  });

  test("split escape sequence across feeds", () => {
    const p = new KeyParser();
    expect(p.feed([0x1b]).map((e) => e.kind)).toEqual([]);
    expect(p.feed([0x5b, 0x41]).map((e) => e.kind)).toEqual(["up"]);
  });

  test("lone ESC finalizes to esc", () => {
    const p = new KeyParser();
    p.feed([0x1b]);
    expect(p.finalize().map((e) => e.kind)).toEqual(["esc"]);
  });

  test("chars after ESC", () => {
    // ESC then 'q'
    const p = new KeyParser();
    expect(p.feed([0x1b, 0x71]).map((e) => e.kind)).toEqual(["esc", "char"]);
  });

  test("SS3 sequences", () => {
    expect(events([0x1b, 0x4f, 0x48]).map((e) => e.kind)).toEqual(["home"]);
  });

  test("mixed", () => {
    const p = new KeyParser();
    const seq = [0x68, 0x69, 0x1b, 0x5b, 0x43, 0x1b, 0x5b, 0x44, 0x0d];
    expect(p.feed(seq).map((e) => e.kind)).toEqual(["char", "char", "right", "left", "enter"]);
  });
});

describe("displayWidth / wrapText", () => {
  test("ascii width", () => {
    expect(displayWidth("hello")).toBe(5);
  });
  test("wide char width", () => {
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("❯")).toBe(2);
  });
  test("wrap no-op when short", () => {
    expect(wrapText("abc", 10)).toEqual(["abc"]);
  });
  test("wrap splits long lines", () => {
    const parts = wrapText("abcdefghij", 4);
    expect(parts).toEqual(["abcd", "efgh", "ij"]);
  });
  test("wrap wide chars respects width", () => {
    const parts = wrapText("中文文", 4);
    expect(parts).toEqual(["中文", "文"]);
  });
  test("wrap splits newlines", () => {
    expect(wrapText("a\nb", 10)).toEqual(["a", "b"]);
  });
});

describe("wrapAnsi", () => {
  test("no ansi is plain wrap", () => {
    expect(wrapAnsi("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  test("keeps leading escape on first segment", () => {
    expect(wrapAnsi("\x1b[33mabcdef", 4)).toEqual(["\x1b[33mabcd", "\x1b[33mef"]);
  });
  test("escape codes cost zero width", () => {
    // 4 visible chars + 2 escapes must fit in width 4
    const [seg] = wrapAnsi("a\x1b[31m\x1b[1mb\x1b[0mc\x1b[0md", 4);
    expect(seg).toBe("a\x1b[31m\x1b[1mb\x1b[0mc\x1b[0md");
  });
  test("splits on newlines and carries the escape per line", () => {
    expect(wrapAnsi("\x1b[32mabc\n\x1b[32mdef", 10)).toEqual(["\x1b[32mabc", "\x1b[32mdef"]);
  });
  test("wide chars count as 2 across ansi", () => {
    const parts = wrapAnsi("\x1b[33m中文文", 4);
    expect(parts).toEqual(["\x1b[33m中文", "\x1b[33m文"]);
  });
});