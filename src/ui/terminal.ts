import { spawnSync } from "node:child_process";
import fs from "node:fs";

export type KeyEvent =
  | { kind: "char"; char: string }
  | { kind: "enter" | "backspace" | "delete" | "left" | "right" | "up" | "down" | "home" | "end" | "pageup" | "pagedown" | "tab" | "esc" | "ctrl-c" | "ctrl-l" | "ctrl-w" | "ctrl-u" | "ctrl-right" | "ctrl-left" }
  | { kind: "scrollup" | "scrolldown" }
  | { kind: "unknown"; raw: string };

/** Enable SGR mouse reporting (motion + wheel). Call on TUI start, disable on exit. */
export function enableMouse(): void {
  out("\x1b[?1000h\x1b[?1006h");
}
export function disableMouse(): void {
  out("\x1b[?1000l\x1b[?1006l");
}

// Emoji / pictographic ranges — all double-width on CJK-capable terminal fonts.
// Covers Emoticons, Misc. Symbols & Pictographs, Transport/Map, Supplemental
// Symbols & Pictographs, Misc. Symbols & Arrows, Chess, Symbols Ext-A, etc.
// code-point width test: true for characters that occupy 2 terminal columns
// (CJK, emoji, wide pictographs). Handles characters above U+FFFF (surrogate
// pairs) via codePointAt(0). Variation selectors / ZWJ are treated as zero-width
// so multi-codepoint emoji sequences don't inflate the column count.
function isWideCP(cp: number): boolean {
  // CJK / wide East Asian / combining marks / enclosed chars (BMP)
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x2500 && cp <= 0x25ff) ||
    (cp >= 0x2700 && cp <= 0x27bf) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  )
    return true;
  // Emoji planes: emoticons, misc symbols & pictographs, transport/map,
  // supplemental symbols & pictographs, chess, symbols ext-A, etc.
  if (
    (cp >= 0x1f300 && cp <= 0x1f5ff) || // misc. symbols & pictographs
    (cp >= 0x1f600 && cp <= 0x1f64f) || // emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // transport & map
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // supplemental symbols & pictographs
    (cp >= 0x1fa00 && cp <= 0x1fa6f) || // chess symbols
    (cp >= 0x1fa70 && cp <= 0x1faff) || // symbols & pictographs ext-A
    (cp >= 0x2b00 && cp <= 0x2bff) || // misc. symbols and arrows
    (cp >= 0x1d000 && cp <= 0x1d0ff) || // Sutton SignWriting
    (cp >= 0x1fb00 && cp <= 0x1fbff) // symbols for legacy computing
  )
    return true;
  return false;
}

export function codeWidth(ch: string): number {
  // Zero-width joiners / variation selectors / combining marks don't add columns
  const cp = ch.codePointAt(0)!;
  if (cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f || (cp >= 0x2000 && cp <= 0x200f)) return 0;
  return isWideCP(cp) ? 2 : 1;
}

/** Display columns a whole string occupies (ANSI escapes excluded). */
export function displayWidth(s: string): number {
  const bare = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of bare) w += codeWidth(ch);
  return w;
}

export function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of s.split("\n")) {
    if (raw === "") {
      out.push("");
      continue;
    }
    let cur = "";
    let curW = 0;
    for (const ch of raw) {
      const cw = codeWidth(ch);
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

const ANSI_SGR = /\x1b\[([0-9;]*)m/g;

function sgrEncode(codes: number[]): string {
  if (codes.length === 0 || (codes.length === 1 && codes[0] === 0)) return "";
  return `\x1b[${codes.join(";")}m`;
}

function sgrApply(codes: number[], spec: string): void {
  const parts = spec === "" ? ["0"] : spec.split(";");
  const fg = (c: number) => (c >= 30 && c <= 37) || (c >= 90 && c <= 97);
  const bg = (c: number) => (c >= 40 && c <= 47) || (c >= 100 && c <= 107);
  for (const raw of parts) {
    const c = Number(raw);
    if (Number.isNaN(c)) continue;
    if (c === 0) {
      codes.length = 0;
      continue;
    }
    if (c === 22 || c === 23 || c === 25 || c === 27) {
      const i = codes.indexOf(c === 22 ? 1 : c === 23 ? 3 : c === 25 ? 8 : c === 27 ? 2 : -1);
      if (i !== -1) codes.splice(i, 1);
      continue;
    }
    if (fg(c)) {
      for (let i = codes.length - 1; i >= 0; i--) if (fg(codes[i])) codes.splice(i, 1);
      codes.push(c);
      continue;
    }
    if (bg(c)) {
      for (let i = codes.length - 1; i >= 0; i--) if (bg(codes[i])) codes.splice(i, 1);
      codes.push(c);
      continue;
    }
    codes.push(c);
  }
}

export function wrapAnsi(s: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of s.split("\n")) {
    if (raw === "") {
      out.push("");
      continue;
    }
    // Tokenize into printable chars with their immediately-preceding escape
    // bytes preserved verbatim, plus the minimally-encoded open styling state
    // (used to reopen attributes on wrapped continuation segments).
    const chars: string[] = [];
    const pre: string[] = [];
    const stateEnc: string[] = [];
    const state: number[] = [];
    let preBuf = "";
    let m: RegExpExecArray | null;
    ANSI_SGR.lastIndex = 0;
    let last = 0;
    const pushRun = (run: string) => {
      for (const ch of run) {
        chars.push(ch);
        pre.push(preBuf);
        preBuf = "";
        stateEnc.push(sgrEncode(state));
      }
    };
    while ((m = ANSI_SGR.exec(raw))) {
      if (m.index > last) pushRun(raw.slice(last, m.index));
      sgrApply(state, m[1]);
      preBuf += m[0];
      last = m.index + m[0].length;
    }
    if (last < raw.length) pushRun(raw.slice(last));
    if (chars.length === 0) {
      out.push("");
      continue;
    }
    // wrap visible text, emitting escapes before their char
    let line = "";
    let w = 0;
    const flush = () => {
      if (!line) return;
      out.push(line);
      line = "";
      w = 0;
    };
    for (let i = 0; i < chars.length; i++) {
      const cw = codeWidth(chars[i]);
      // verbatim escapes always; reopen open-state only at segment start
      const prefix = pre[i] !== "" ? pre[i] : line === "" ? stateEnc[i] : "";
      if (w + cw > width) {
        if (!line) {
          // single char wider than width; emit it alone
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

export function out(s: string): void {
  process.stdout.write(s.replace(/\n/g, "\r\n"));
}

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

export function fg(n: number): string {
  return `\x1b[${30 + n}m`;
}

export function paint(s: string, color?: number): string {
  return color === undefined ? s : `${fg(color)}${s}${ansi.reset}`;
}

let ttyState: boolean | null = null;

export function hasControllingTty(): boolean {
  if (ttyState !== null) return ttyState;
  try {
    const fd = fs.openSync("/dev/tty", "r+");
    fs.closeSync(fd);
    ttyState = true;
  } catch {
    ttyState = false;
  }
  return ttyState;
}

function ttyStty(args: string[]): string {
  const r = spawnSync("stty", ["-F", "/dev/tty", ...args], { encoding: "utf8" });
  return r.stdout?.trim() ?? "";
}

export function getSize(): { rows: number; cols: number } {
  // Fast path: no subprocess spawn when the TTY exposes its size. We accept
  // any usable size here — a genuinely small terminal (e.g. 3×20) is honored
  // rather than overridden with 24×80.
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
  } catch {
    /* keep defaults */
  }
  if (!(Number.isFinite(r) && Number.isFinite(c) && r > 0 && c > 0)) {
    // size unknown / unusably small (e.g. pty reports 0x0) -> sensible default
    return { rows: 24, cols: 80 };
  }
  return { rows: r, cols: c };
}

export function enableRawMode(): void {
  ttyStty(["raw", "-echo"]);
}

export function restoreTerminal(): void {
  if (!hasControllingTty()) return;
  try {
    ttyStty(["sane"]);
    ttyStty(["echo"]);
  } catch {
    /* ignore */
  }
}

const FINAL_BYTE = (b: number) => (b >= 0x40 && b <= 0x7e) || b === 0x1b;

function singleKey(b: number): KeyEvent {
  switch (b) {
    case 0x0d:
    case 0x0a:
      return { kind: "enter" };
    case 0x7f:
    case 0x08:
      return { kind: "backspace" };
    case 0x09:
      return { kind: "tab" };
    case 0x03:
      return { kind: "ctrl-c" };
    case 0x0c:
      return { kind: "ctrl-l" };
    case 0x17:
      return { kind: "ctrl-w" };
    case 0x15:
      return { kind: "ctrl-u" };
    case 0x01:
      return { kind: "home" };
    case 0x05:
      return { kind: "end" };
    case 0x1b:
      return { kind: "esc" };
    default: {
      if (b >= 0x20 && b <= 0x7e) return { kind: "char", char: String.fromCharCode(b) };
      if (b >= 0xc0 && b < 0xfe) return { kind: "unknown", raw: String.fromCharCode(b) };
      return { kind: "unknown", raw: `\\x${b.toString(16).padStart(2, "0")}` };
    }
  }
}

function csiKey(bytes: number[]): KeyEvent {
  // bytes: everything after CSI
  let final = -1;
  let idx = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (FINAL_BYTE(bytes[i])) {
      final = bytes[i];
      idx = i;
      break;
    }
  }
  if (final === -1) return { kind: "unknown", raw: `CSI<${bytes.map((b) => b.toString(16)).join(" ")}>` };

  const paramStr = bytes
    .slice(0, idx)
    .map((b) => String.fromCharCode(b))
    .join("")
    .split(";")
    .filter((p) => p !== "");
  const params = paramStr;
  const mod = params.length >= 2 ? parseInt(params[1], 10) : undefined;
  const ctrl = mod === 5 || mod === 2 ? true : false;

  // SGR mouse reports: CSI < b ; x ; y M|m   (wheel: button 64/65)
  if (params[0]?.startsWith("<")) {
    const btn = parseInt(params[0].slice(1), 10);
    if (btn === 64) return { kind: "scrollup" };
    if (btn === 65) return { kind: "scrolldown" };
    return { kind: "unknown", raw: params.join(";") + String.fromCharCode(final) };
  }

  if (final === 0x41) return { kind: "up" };
  if (final === 0x42) return { kind: "down" };
  if (final === 0x43) return ctrl ? { kind: "ctrl-right" } : { kind: "right" };
  if (final === 0x44) return ctrl ? { kind: "ctrl-left" } : { kind: "left" };
  if (final === 0x48) return { kind: "home" };
  if (final === 0x46) return { kind: "end" };
  if (final === 0x7e) {
    const p = parseInt(params[0] ?? "", 10);
    if (p === 3) return { kind: "delete" };
    if (p === 1) return { kind: "home" };
    if (p === 4) return { kind: "end" };
    if (p === 5) return { kind: "pageup" };
    if (p === 6) return { kind: "pagedown" };
  }
  return { kind: "unknown", raw: `CSI${params.join(";")}${String.fromCharCode(final)}` };
}

export class KeyParser {
  private hold: number[] = [];

  feed(bytes: number[]): KeyEvent[] {
    const all = [...this.hold, ...bytes];
    const out: KeyEvent[] = [];
    let i = 0;
    this.hold = [];

    while (i < all.length) {
      const b = all[i];
      if (b !== 0x1b) {
        out.push(singleKey(b));
        i++;
        continue;
      }
      // escape: look for a complete sequence
      const rest = all.slice(i + 1);
      if (rest.length === 0) {
        this.hold = [b];
        i = all.length;
        break;
      }
      if (rest[0] === 0x5b) {
        // CSI ...: find final byte
        let fin = -1;
        for (let j = 1; j < rest.length; j++) {
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
        out.push(csiKey(rest.slice(1, fin + 1)));
        i += 1 + fin + 1;
      } else if (rest[0] === 0x4f) {
        // SS3
        if (rest.length < 2 || !FINAL_BYTE(rest[1])) {
          this.hold = [...all.slice(i), ...(rest.length >= 2 ? [] : [])];
          this.hold = all.slice(i);
          i = all.length;
          break;
        }
        const c = rest[1];
        const map: Record<number, KeyEvent> = {
          0x41: { kind: "up" },
          0x42: { kind: "down" },
          0x43: { kind: "right" },
          0x44: { kind: "left" },
          0x48: { kind: "home" },
          0x46: { kind: "end" },
        };
        out.push(map[c] ?? { kind: "unknown", raw: `SS3${String.fromCharCode(c)}` });
        i += 3;
      } else {
        // lone ESC followed by something else -> ESC then re-process the byte
        out.push({ kind: "esc" });
        i += 1;
      }
    }
    return out;
  }

  finalize(): KeyEvent[] {
    if (this.hold.length === 1 && this.hold[0] === 0x1b) {
      this.hold = [];
      return [{ kind: "esc" }];
    }
    if (this.hold.length) {
      const evs: KeyEvent[] = [];
      for (const b of this.hold) evs.push(singleKey(b) as KeyEvent);
      this.hold = [];
      return evs;
    }
    return [];
  }

  hasPending(): boolean {
    return this.hold.length > 0;
  }
}

export class KeyReader {
  private parser = new KeyParser();
  private pending: KeyEvent[] = [];
  private chunks: Buffer[] = [];
  private resolvers: ((b: Buffer) => void)[] = [];
  private closed = false;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (d: Buffer) => {
      if (this.resolvers.length) this.resolvers.shift()!(d);
      else this.chunks.push(d);
    });
    stream.on("end", () => {
      this.closed = true;
      while (this.resolvers.length) this.resolvers.shift()!(Buffer.alloc(0));
    });
  }

  private nextChunk(): Promise<Buffer> {
    if (this.closed) return Promise.resolve(Buffer.alloc(0));
    if (this.chunks.length) return Promise.resolve(this.chunks.shift()!);
    return new Promise((r) => this.resolvers.push(r));
  }

  async next(): Promise<KeyEvent> {
    for (;;) {
      if (this.pending.length) return this.pending.shift()!;
      if (this.parser.hasPending()) {
        // possible lone ESC: wait briefly for a continuation byte
        await new Promise((r) => setTimeout(r, 25));
        const late = this.parser.feed([]);
        if (late.length) this.pending.push(...late);
        const fin = this.parser.finalize();
        if (fin.length) this.pending.push(...fin);
        continue;
      }
      const chunk = await this.nextChunk();
      if (chunk.length === 0) return { kind: "unknown", raw: "<eof>" };
      const evs = this.parser.feed([...chunk]);
      if (evs.length) this.pending.push(...evs);
    }
  }
}