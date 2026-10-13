// Clipboard access for the interactive REPL (Ctrl+C copy / Ctrl+V paste).
//
// Why this exists: the OS clipboard has no Node API, and the obvious shims are
// painfully slow on modest Windows boxes (a single `powershell -Command` round
// trip measured 6–33s here). So Windows gets a tiny native helper — a plain
// Win32 C# exe compiled once with the .NET Framework compiler that ships with
// every Windows — which reads/writes the clipboard in ~100ms. Everything else
// falls back to the usual per-platform CLI tools (pbpaste/pbcopy, wl-copy,
// xclip…), and finally to PowerShell, slow but correct.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Reduce arbitrary clipboard text to something safe to splice into the
 *  single-line prompt: newlines/tabs become spaces (readline submits on "\n",
 *  so a pasted multi-line snippet must stay on one line), remaining control
 *  bytes are dropped, edges are trimmed. Interior spacing is preserved. */
export function normalizeForPrompt(text: string): string {
  return text
    .replace(/\r\n?|\n|\t/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trim();
}

/** The Windows helper: Win32 clipboard via P/Invoke, UTF-8 on both std streams.
 *  Kept as source (not a binary) so the install stays text-only; it compiles
 *  once into ~/.vibecoder/bin and is reused after that. */
export const HELPER_SOURCE = `using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class VibecoderClip
{
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();
    [DllImport("user32.dll")]
    private static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr hMem);

    private static bool OpenWithRetry()
    {
        for (int i = 0; i < 10; i++)
        {
            if (OpenClipboard(IntPtr.Zero)) return true;
            System.Threading.Thread.Sleep(30);
        }
        return false;
    }

    private static int Main(string[] args)
    {
        string cmd = args.Length > 0 ? args[0] : "get";
        try
        {
            if (cmd == "set")
            {
                MemoryStream ms = new MemoryStream();
                Console.OpenStandardInput().CopyTo(ms);
                return SetText(Encoding.UTF8.GetString(ms.ToArray()));
            }
            return GetText();
        }
        catch (Exception ex)
        {
            Console.Error.Write(ex.ToString());
            return 3;
        }
    }

    private static int SetText(string text)
    {
        if (!OpenWithRetry()) { Console.Error.Write("clipboard locked"); return 4; }
        try
        {
            EmptyClipboard();
            if (text.Length == 0) return 0;
            IntPtr hMem = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)((text.Length + 1) * 2));
            if (hMem == IntPtr.Zero) return 5;
            IntPtr ptr = GlobalLock(hMem);
            if (ptr == IntPtr.Zero) return 6;
            char[] chars = text.ToCharArray();
            Marshal.Copy(chars, 0, ptr, chars.Length);
            Marshal.WriteInt16(ptr, chars.Length * 2, 0);
            GlobalUnlock(hMem);
            if (SetClipboardData(CF_UNICODETEXT, hMem) == IntPtr.Zero) return 7;
            return 0;
        }
        finally { CloseClipboard(); }
    }

    private static int GetText()
    {
        if (!OpenWithRetry()) { Console.Error.Write("clipboard locked"); return 4; }
        string text = "";
        bool have = false;
        try
        {
            IntPtr hMem = GetClipboardData(CF_UNICODETEXT);
            if (hMem != IntPtr.Zero)
            {
                IntPtr ptr = GlobalLock(hMem);
                if (ptr != IntPtr.Zero)
                {
                    text = Marshal.PtrToStringUni(ptr);
                    GlobalUnlock(hMem);
                    have = true;
                }
            }
        }
        finally { CloseClipboard(); }
        if (!have) return 0;
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        Console.OpenStandardOutput().Write(bytes, 0, bytes.Length);
        return 0;
    }
}
`;

function helperExe(): string {
  return join(homedir(), ".vibecoder", "bin", "vibecoder-clip.exe");
}

function findCsc(): string | null {
  const root = process.env.WINDIR ?? "C:\\Windows";
  const candidates = [
    join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(root, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

let helperState: "unknown" | "ready" | "missing" = "unknown";

/** Compile (once) and return the Windows clipboard helper, or null when the
 *  machine can't build it (no .NET Framework compiler). */
function ensureHelper(): string | null {
  if (process.platform !== "win32") return null;
  if (helperState === "ready") return helperExe();
  if (helperState === "missing") return null;
  const exe = helperExe();
  if (existsSync(exe)) {
    helperState = "ready";
    return exe;
  }
  const csc = findCsc();
  if (!csc) {
    helperState = "missing";
    return null;
  }
  try {
    mkdirSync(dirname(exe), { recursive: true });
    const src = join(dirname(exe), "vibecoder-clip.cs");
    writeFileSync(src, HELPER_SOURCE, "utf8");
    const r = spawnSync(csc, ["/nologo", "/optimize+", "/target:exe", `/out:${exe}`, src], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (r.status !== 0 || !existsSync(exe)) {
      helperState = "missing";
      return null;
    }
    try {
      rmSync(src, { force: true });
    } catch {
      /* the source next to the exe is harmless if cleanup fails */
    }
    helperState = "ready";
    return exe;
  } catch {
    helperState = "missing";
    return null;
  }
}

/** Run a command, feeding optional stdin, with a hard timeout. */
function run(
  cmd: string,
  args: string[],
  input?: string,
  timeoutMs = 8000,
): Promise<{ code: number; out: string } | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: Buffer.concat(out).toString("utf8") || Buffer.concat(errs).toString("utf8") });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => errs.push(d));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    // The child can die before we finish writing (missing binary, killed by a
    // timeout) — without a listener, the resulting EPIPE would crash the REPL.
    child.stdin.on("error", () => finish(null));
    if (input !== undefined) child.stdin.end(input, "utf8");
    else child.stdin.end();
  });
}

/** Read the system clipboard. Resolves null when no backend is available. */
export async function readClipboard(): Promise<string | null> {
  const exe = ensureHelper();
  if (exe) {
    const r = await run(exe, ["get"]);
    if (r && r.code === 0) return r.out;
    // helper present but failing (e.g. clipboard locked) → fall through to PS
  }
  if (process.platform === "win32") {
    const r = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw"],
      undefined,
      20_000,
    );
    return r && r.code === 0 ? r.out : null;
  }
  if (process.platform === "darwin") {
    const r = await run("pbpaste", []);
    return r && r.code === 0 ? r.out : null;
  }
  const tries: [string, string[]][] = [
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--output", "--clipboard"]],
  ];
  for (const [cmd, args] of tries) {
    const r = await run(cmd, args);
    if (r && r.code === 0) return r.out;
  }
  return null;
}

/** Copy text to the system clipboard. Resolves false when nothing worked. */
export async function writeClipboard(text: string): Promise<boolean> {
  const exe = ensureHelper();
  if (exe) {
    const r = await run(exe, ["set"], text);
    if (r && r.code === 0) return true;
  }
  if (process.platform === "win32") {
    // PowerShell's redirected stdin uses the console codepage (mangles UTF-8),
    // so hand the text over via a temp file instead.
    const tmp = join(homedir(), ".vibecoder", `clip-${process.pid}-${Date.now()}.txt`);
    try {
      mkdirSync(dirname(tmp), { recursive: true });
      writeFileSync(tmp, text, "utf8");
      const ps = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Set-Clipboard -Value ([IO.File]::ReadAllText('${tmp.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`;
      const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], undefined, 20_000);
      return !!r && r.code === 0;
    } catch {
      return false;
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
  if (process.platform === "darwin") {
    const r = await run("pbcopy", [], text);
    return !!r && r.code === 0;
  }
  const tries: [string, string[]][] = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard", "-in"]],
    ["xsel", ["--input", "--clipboard"]],
  ];
  for (const [cmd, args] of tries) {
    const r = await run(cmd, args, text);
    if (r && r.code === 0) return true;
  }
  return false;
}

/** Outcome of a guarded copy. */
export type CopyOutcome =
  | { action: "copied"; chars: number }
  | { action: "kept"; chars: number }
  | { action: "failed" };

/** Copy text without silently destroying something the user copied elsewhere.
 *
 *  Terminals forward Ctrl+C to the app whenever no selection is active
 *  (Windows Terminal does this by default), so an app-side "copy the reply"
 *  can land on top of a URL or snippet the user copied a moment before — and
 *  the next paste then delivers the reply instead of their text, which reads
 *  as "my paste is broken". So: read the clipboard first, and only write when
 *  it's empty, already holds this text, or can't be read at all (best effort —
 *  trying beats refusing when the user did press copy on purpose). */
export async function copyUnlessForeign(text: string): Promise<CopyOutcome> {
  const existing = await readClipboard();
  if (existing !== null && existing.trim() !== "" && existing.trim() !== text.trim()) {
    return { action: "kept", chars: existing.length };
  }
  const ok = await writeClipboard(text);
  return ok ? { action: "copied", chars: text.length } : { action: "failed" };
}
