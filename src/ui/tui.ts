import { KeyReader, type KeyEvent, ansi, displayWidth, enableRawMode, getSize, out, paint, restoreTerminal, wrapAnsi, wrapText } from "./terminal";

export type ConfirmAnswer = "yes" | "no" | "all";

export interface TUICallbacks {
  onSubmit(line: string): void;
  onAbort(): void;
  onResize?(rows: number, cols: number): void;
}

interface StreamLine {
  text: string;
  color?: number;
  bold?: boolean;
}

interface StatusLine {
  text: string;
  color?: number;
}

const MAX_SCROLLBACK = 2000;

export class TUI {
  private rows: number;
  private cols: number;
  private reader: KeyReader;
  scrollback: StreamLine[] = [];
  private stream: StreamLine = { text: "" };
  private status: StatusLine = { text: "" };
  private scrollOffset = 0;
  private input = "";
  private cursor = 0;
  private history: string[] = [];
  private histIdx = -1;
  busy = false;
  approveMode: "off" | "on" = "off";
  private running = true;
  private keyHandler: ((ev: KeyEvent) => void) | null = null;
  private commands = ["help", "clear", "provider", "model", "approve", "exit"];
  private promptOverride: string | null = null;

  constructor(rows: number, cols: number, private callbacks: TUICallbacks) {
    this.rows = rows;
    this.cols = cols;
    this.reader = new KeyReader(process.stdin);
  }

  start(): void {
    const s = getSize();
    this.rows = s.rows;
    this.cols = s.cols;
    out("\x1b[?1049h"); // alternate screen
    out("\x1b[?25l"); // hide cursor
    enableRawMode();
    out("\x1b[H\x1b[2J");
    this.render();
    process.stdout.on("resize", this.onWinch);
    this.loop();
  }

  private onWinch = () => {
    const s = getSize();
    this.rows = s.rows;
    this.cols = s.cols;
    this.callbacks.onResize?.(this.rows, this.cols);
    this.render();
  };

  private async loop(): Promise<void> {
    while (this.running) {
      const ev = await this.reader.next();
      if (!this.running) break;
      if (this.keyHandler) {
        const h = this.keyHandler;
        this.keyHandler = null;
        h(ev);
        this.render();
        continue;
      }
      if (this.busy) {
        if (ev.kind === "ctrl-c") this.callbacks.onAbort();
        else if (ev.kind === "ctrl-l") this.render();
        else if (ev.kind === "pageup") { this.scrollBy(this.pageSize()); this.render(); }
        else if (ev.kind === "pagedown") { this.scrollBy(-this.pageSize()); this.render(); }
        continue;
      }
      this.handleIdle(ev);
      if (this.running) this.render();
    }
  }

  private handleIdle(ev: KeyEvent): void {
    switch (ev.kind) {
      case "char":
        this.input = this.input.slice(0, this.cursor) + ev.char + this.input.slice(this.cursor);
        this.cursor++;
        break;
      case "enter":
        if (!this.input.trim()) return;
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
        if (this.cursor > 0) this.cursor--;
        break;
      case "ctrl-left": {
        const before = this.input.slice(0, this.cursor);
        const m = before.match(/(\w+)$/);
        if (m) this.cursor -= m[1].length;
        break;
      }
      case "right":
        if (this.cursor < this.input.length) this.cursor++;
        break;
      case "ctrl-right": {
        const after = this.input.slice(this.cursor);
        const m = after.match(/^\s*(\w+)/);
        if (m) this.cursor += m[0].length;
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
        if (m) this.cursor -= m[1].length;
        break;
      }
      case "up":
        if (this.histIdx === -1 && this.history.length) this.histIdx = this.history.length;
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
      case "esc":
      default:
        break;
    }
  }

  private complete(): void {
    if (!this.input.startsWith("/")) return;
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

  private pageSize(): number {
    return Math.max(1, this.rows - 4);
  }

  private scrollBy(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
  }

  private submit(): void {
    const line = this.input;
    this.input = "";
    this.cursor = 0;
    this.history.push(line);
    if (this.history.length > 100) this.history.shift();
    this.histIdx = -1;
    this.callbacks.onSubmit(line);
  }

  // ---- output API ----

  printToScrollback(text: string, clamp?: boolean): void {
    this.pushStreamLines(text, clamp);
  }

  streamText(text: string, color?: number): void {
    this.stream.color = color;
    if (!text) {
      this.render();
      return;
    }
    const hasNewline = text.includes("\n");
    this.stream.text += text;
    if (hasNewline) {
      const lines = this.stream.text.split("\n");
      this.stream.text = lines.pop() ?? "";
      for (const l of lines) this.scrollback.push({ text: l, color: this.stream.color });
    }
    this.render();
  }

  endStream(): void {
    if (this.stream.text) {
      this.scrollback.push({ text: this.stream.text, color: this.stream.color });
      this.stream.text = "";
    }
    this.render();
  }

  setStatus(text: string, color?: number): void {
    this.status = { text, color };
    this.render();
  }

  private pushStreamLines(text: string, clamp?: boolean): void {
    for (const l of text.split("\n")) {
      if (clamp && this.scrollback.length > MAX_SCROLLBACK) break;
      this.scrollback.push({ text: l });
      if (this.scrollback.length > MAX_SCROLLBACK) this.scrollback.shift();
    }
    this.render();
  }

  clearScrollback(): void {
    this.scrollback = [];
    this.stream = { text: "" };
    this.scrollOffset = 0;
    this.render();
  }

  // ---- approval ----

  askConfirm(question: string): Promise<ConfirmAnswer> {
    if (this.approveMode === "off") return Promise.resolve("yes");
    return new Promise((resolve) => {
      this.promptOverride = `${question}  ${ansi.bold}[y/n/a]${ansi.reset}`;
      this.render();
      this.keyHandler = (ev) => {
        if (ev.kind === "char" && (ev.char === "y" || ev.char === "Y")) {
          this.promptOverride = null;
          resolve("yes");
        } else if (ev.kind === "char" && (ev.char === "n" || ev.char === "N")) {
          this.promptOverride = null;
          resolve("no");
        } else if (ev.kind === "char" && (ev.char === "a" || ev.char === "A")) {
          this.promptOverride = null;
          resolve("all");
        } else if (ev.kind === "ctrl-c") {
          this.promptOverride = null;
          resolve("no");
        } else {
          this.render();
        }
      };
    });
  }

  // ---- rendering ----

  private render(): void {
    const bottomRows = 2; // status + input
    const contentRows = Math.max(1, this.rows - bottomRows);
    const colW = Math.max(10, this.cols - 1);

    const rendered: string[] = [];
    for (const l of this.scrollback) {
      const segments = l.text.includes("\x1b") ? wrapAnsi(l.text, colW) : wrapText(l.text, colW);
      for (const s of segments) {
        let t = s;
        if (l.bold) t = ansi.bold + t;
        if (l.color !== undefined) t = paint(t, l.color);
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

    // Move to origin (top of alt screen) and repaint
    let output = "\x1b[H";
    for (let r = 0; r < contentRows; r++) {
      const line = vis[r];
      output += `\x1b[${r + 1};1H`;
      output += line ? line + "\x1b[K" : "\x1b[K";
    }

    // status row (with a scroll-back indicator when the user has paged up)
    let statusText = this.status.text;
    if (this.scrollOffset > 0) {
      statusText = `${statusText}  ${ansi.dim}↑${this.scrollOffset}/${total}${ansi.reset}`;
    }
    output += `\x1b[${this.rows - 1};1H`;
    output += statusText ? paint(statusText.slice(0, colW), this.status.color) + "\x1b[K" : "\x1b[K";

    // input row
    const inputRow = this.rows;
    output += `\x1b[${inputRow};1H`;
    if (this.promptOverride) {
      output += this.promptOverride.slice(0, colW) + "\x1b[K";
      out(output);
      return;
    }

    const prefix = ansi.green + "❯" + ansi.reset + " ";
    const prefixW = displayWidth("\u276f") + 1;
    const maxTextW = colW - prefixW - 1;
    let start = 0;
    let truncated = false;
    if (displayWidth(this.input) > maxTextW) {
      truncated = true;
      let w = 0;
      for (let i = 0; i < this.cursor; i++) {
        w += displayWidth(this.input[i] ?? "");
        if (w > maxTextW) {
          start = i + 1;
          break;
        }
      }
    }
    const shown = truncated ? "…" + this.input.slice(start) : this.input;
    output += prefix + shown;
    let leadW: number;
    if (truncated && this.cursor === 0) leadW = 0;
    else if (truncated) leadW = 1 + displayWidth(this.input.slice(start, this.cursor));
    else leadW = displayWidth(this.input.slice(0, this.cursor));
    const cursorCol = 1 + prefixW + leadW;
    output += "\x1b[K";
    output += `\x1b[${inputRow};${Math.min(cursorCol, colW + 1)}H`;

    out(output);
  }

  close(): void {
    if (!this.running) return;
    this.running = false;
    process.stdout.removeListener("resize", this.onWinch);
    out("\x1b[?25h");
    out("\x1b[?1049l");
    restoreTerminal();
    process.stdout.write("\r\n");
  }
}