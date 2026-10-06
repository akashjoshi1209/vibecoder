// Shell-command parsing and classification - the pure, policy-free half of
// the permission model.
//
// Everything here answers "what would this command do?" (parse into simple
// commands, classify destructive/network intent). It never answers "may it
// run?" - that is policy, and it lives in ../permissions.ts (decide()).
// Keeping the split here is what makes the classifier table-testable without
// a Permissions object or a shell.
//
// The wordlist-over-raw-string approach that preceded this was unsound: the
// shell resolves nesting, substitution and expansion long after any regex has
// run, so we parse into the simple commands that would actually execute and
// match on argv[0] (plus the flags that are destructive on their own).
// ── shell command analysis ────────────────────────────────────────────────────
//
// The previous implementation split the raw command string on `;`/`&`/`|` and
// anchored each segment with `^`. Every one of these walked straight through it
// while a real `bash -lc` executed them:
//
//   echo $(rm -rf x)      backtick `rm -rf x`      sh -c 'rm -rf x'
//   bash -c 'rm -rf x'    find . -delete           find . | xargs rm
//   R=rm; $R -rf x        rm -rf x<newline>rm -rf y       git clean -fd
//   echo x | tee f        del f                   Remove-Item -Recurse f
//
// A wordlist over a raw string cannot be sound, because the shell resolves
// nesting, substitution and variable expansion long after any regex has run.
// So we parse the command into the simple commands it would actually execute
// and match on argv[0] (plus the specific flags that are destructive on their
// own). This is still a heuristic layer, not an OS sandbox — see
// `checkDestructiveCommand` for what that means in practice.

/** One simple command: the argv the shell would build, plus its raw text. */
export interface SimpleCommand {
  argv: string[];
  raw: string;
}

/** Commands that execute another command given as an argument. */
const NESTING_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash", "fish", "busybox", "env", "sudo", "doas", "nohup", "timeout", "xargs", "watch", "stdbuf", "nice", "command", "builtin", "eval"]);

/** Read a balanced `(`...`)` starting at `open` (index of `(`). Returns the
 *  inner text and the index just past the closing paren, or null if unbalanced. */
function readParen(src: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\" && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Pull subshell bodies (`$(...)`, `` `...` ``, `<(...)`, `>(...)`) out of `src`,
 *  returning the source with them blanked plus their bodies for recursion. */
function extractNested(src: string, depth: number, acc: string[]): string {
  if (depth > 6) return src;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // `cmd`  (backtick substitution)
    if (c === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > 0) {
        acc.push(src.slice(i + 1, close));
        out += " ";
        i = close + 1;
        continue;
      }
    }
    // $(cmd), <(cmd), >(cmd)
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

/** Split on top-level shell metacharacters, honouring quotes. */
function splitSegments(src: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') { cur += src[++i] ?? ""; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\") { cur += c + (src[++i] ?? ""); continue; }
    if (c === "\n" || c === ";" || c === "|") {
      if (cur.trim()) segs.push(cur);
      cur = "";
      continue;
    }
    if (c === "&") {
      if (cur.trim()) segs.push(cur);
      cur = "";
      // skip the second & of &&
      if (src[i + 1] === "&") i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) segs.push(cur);
  return segs;
}

/** Tokenise one segment into argv, dropping quotes and comments. */
function tokenize(seg: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === "\\" && quote === '"') { cur += seg[++i] ?? ""; has = true; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "\\") { cur += seg[++i] ?? ""; has = true; continue; }
    if (c === "#" && !has) break; // comment to end of segment
    if (/\s/.test(c)) {
      if (has || cur) { tokens.push(cur); cur = ""; has = false; }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) tokens.push(cur);
  return tokens;
}

/** Strip leading `VAR=value` / `VAR+=value` assignments so `$R -rf x` is
 *  recognised as `rm -rf x`. */
function stripAssignments(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*(\+)?=/.test(argv[i])) i++;
  return argv.slice(i);
}

/**
 * Resolve simple `$VAR` / `${VAR}` references against assignments seen earlier
 * in the same command, so `R=rm; $R -rf x` is recognised as `rm -rf x`.
 *
 * Deliberately shallow: only variables assigned a literal value in the command
 * text are substituted. Expanding $PATH or $HOME from the real environment
 * would invent commands that are not there, so unresolvable references are
 * left alone. The goal is to stop trivial aliasing, not to emulate bash.
 */
function expandVars(argv: string[], vars: Map<string, string>): string[] {
  if (!vars.size) return argv;
  return argv.map((tok) => {
    if (!tok.includes("$")) return tok;
    return tok.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) =>
      vars.has(name) ? vars.get(name)! : whole,
    );
  });
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Resolve a command word to a bare name: `/usr/bin/rm` -> `rm`, `./x` -> `x`,
 *  `C:\Windows\del.exe` -> `del`. Strips a trailing `.exe`/`.cmd`/`.bat`. */
function commandName(word: string): string {
  let w = word;
  // A Windows path may use backslashes; basename handles both on win32.
  if (/[\\/]/.test(w)) w = w.split(/[\\/]/).pop() ?? w;
  return w.replace(/\.(exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
}

/** Options that make otherwise-innocuous commands destructive, keyed by
 *  command name. Checked against the full argv, not just argv[0]. */
const DESTRUCTIVE_FLAGS: Record<string, { flags: RegExp; why: string }[]> = {
  git: [
    { flags: /\b(clean)\b[\s\S]*\s-[a-z]*[fd]/, why: "git clean removing untracked files" },
    { flags: /\breset\b[\s\S]*--hard/, why: "git reset --hard discarding committed work" },
    { flags: /\bcheckout\b[\s\S]*\s--\s/, why: "git checkout -- discarding working-tree changes" },
    { flags: /\brestore\b/, why: "git restore overwriting working-tree files" },
    { flags: /\bpush\b[\s\S]*\s--force(?!-with-lease)/, why: "git push --force rewriting remote history" },
    { flags: /\bremote\b[\s\S]*\bset-url\b/, why: "git remote set-url repointing the remote" },
    { flags: /\bbranch\b[\s\S]*\s-D\b/, why: "git branch -D force-deleting a branch" },
  ],
  find: [
    { flags: /\s-(delete|exec|execdir|ok)\b/, why: "find deleting or executing on matches" },
  ],
  chmod: [{ flags: /\s-R\b/, why: "recursive chmod" }],
  chown: [{ flags: /\s-R\b/, why: "recursive chown" }],
  dd: [{ flags: /\bof=/, why: "dd writing raw data to a device or file" }],
  powershell: [
    { flags: /\b(Remove-Item|Remove-ItemProperty|Clear-Content|rd|rm|del|erase)\b/i, why: "PowerShell file/directory removal" },
    { flags: /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, why: "disk/volume destruction" },
    { flags: /\bStop-Process|Stop-Service|Restart-Computer|Stop-Computer\b/i, why: "process/system control" },
  ],
  pwsh: [
    { flags: /\b(Remove-Item|Clear-Content|rd|rm|del|erase)\b/i, why: "PowerShell file/directory removal" },
    { flags: /\bStop-Process|Stop-Service|Restart-Computer|Stop-Computer\b/i, why: "process/system control" },
  ],
  cmd: [
    { flags: /\b(rd|rmdir)\b[\s\S]*\/s/i, why: "recursive directory removal" },
  ],
  registry: [{ flags: /\b(delete|remove)\b/i, why: "registry deletion" }],
  cipher: [{ flags: /\s\/w\b/, why: "cipher wiping free space" }],
  diskpart: [{ flags: /\bclean\b/, why: "diskpart clean erasing a disk" }],
};

const DESTRUCTIVE_CMDS: Record<string, string> = {
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
  // Windows-native removal
  del: "file removal (del)",
  erase: "file removal (erase)",
  rd: "recursive directory removal (rd)",
  format: "filesystem format (format)",
  cipher: "file/disk wiping (cipher)",
  bcdedit: "boot configuration edit (bcdedit)",
  diskpart: "disk partitioning (diskpart)",
};

const NETWORK_CMDS: Record<string, string> = {
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
  // Windows-native
  bitsadmin: "BITS transfer (bitsadmin)",
  certutil: "certutil download/URL fetch",
};

const NETWORK_CMDFLAGS: Record<string, { flags: RegExp; why: string }[]> = {
  git: [{ flags: /\b(clone|fetch|pull|push|submodule|remote)\b/, why: "git network operation" }],
  powershell: [
    { flags: /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|Net\.WebClient|System\.Net\.Http)\b/i, why: "PowerShell web request" },
  ],
  pwsh: [
    { flags: /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|Net\.WebClient|System\.Net\.Http)\b/i, why: "PowerShell web request" },
  ],
};

/** Interpreters that can reach the network with a one-liner. Matching the
 *  interpreter name alone would block every local script run, so we only flag
 *  the inline-evaluation forms. */
const NETWORK_INTERPRETERS: Record<string, string> = {
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
  curl_: "curl",
};

const INLINE_EVAL_FLAGS = /^(-[a-z]*[ce]|--eval|--execute|-Command|-EncodedCommand|-c)$/i;

/** Flags that mean "show help", not "do the thing". `rm --help` must not be
 *  treated as a deletion, or every guard blocks harmless introspection. */
const HELP_FLAGS = new Set([
  "-h", "--help", "-help", "/?", "/h", "-v", "--version", "--usage",
]);

function isHelpInvocation(cmd: SimpleCommand): boolean {
  return cmd.argv.slice(1).some((a) => HELP_FLAGS.has(a.toLowerCase()));
}

function destructiveReasonFor(cmd: SimpleCommand): string | null {
  const name = commandName(cmd.argv[0] ?? "");
  if (!name) return null;
  if (isHelpInvocation(cmd)) return null;
  const base = DESTRUCTIVE_CMDS[name];
  if (base) return base;
  // `mkfs.ext4`, `mkfs.xfs`, `mkfs.btrfs` and friends.
  if (name.startsWith("mkfs.")) return `filesystem creation (${name})`;
  for (const { flags, why } of DESTRUCTIVE_FLAGS[name] ?? []) {
    if (flags.test(cmd.raw)) return why;
  }
  // `find . -exec rm {} +` — the nested command is destructive even though
  // find itself is not on the list.
  if (name === "find") {
    const ex = cmd.argv.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok");
    if (ex >= 0) {
      const inner = stripAssignments(cmd.argv.slice(ex + 1)).map(commandName);
      const innerName = inner[0] ?? "";
      if (DESTRUCTIVE_CMDS[innerName]) return `find -exec ${innerName} (${DESTRUCTIVE_CMDS[innerName]})`;
    }
  }
  // PowerShell runs cmdlets inside a -Command string, not as argv.
  if (name === "powershell" || name === "pwsh") {
    const joined = cmd.argv.join(" ");
    if (/\b(Remove-Item|Clear-Content|rd\s|rm\s|del\s|erase\s|Stop-Process|Stop-Service|Format-Volume)\b/i.test(joined)) {
      return "PowerShell destructive cmdlet";
    }
  }
  return null;
}

function networkReasonFor(cmd: SimpleCommand): string | null {
  const name = commandName(cmd.argv[0] ?? "");
  if (!name) return null;
  const base = NETWORK_CMDS[name];
  if (base) return base;
  for (const { flags, why } of NETWORK_CMDFLAGS[name] ?? []) {
    if (flags.test(cmd.raw)) return why;
  }
  // Inline-evaluation interpreter: `python -c "...urlopen..."`, `node -e fetch`.
  if (NETWORK_INTERPRETERS[name]) {
    const inline = cmd.argv.slice(1).find((a) => INLINE_EVAL_FLAGS.test(a));
    if (inline) return `${NETWORK_INTERPRETERS[name]} inline code (${inline}) can open network connections`;
  }
  // Redirection into a netcat-ish pipe, or `curl` smuggled via a variable.
  if (/\b(Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b/i.test(cmd.raw)) {
    return "PowerShell web request";
  }
  return null;
}

/** Expand `command` into every simple command a shell would run, recursing
 *  through subshells, backticks, process substitution, variable assignment and
 *  wrapper commands (`sh -c`, `xargs`, `sudo`, `env`, ...). */
export function parseCommands(command: string, depth = 0): SimpleCommand[] {
  if (depth > 8) return [];
  // Assignments are tracked per top-level parse so a later segment can
  // reference an earlier `VAR=value`. The recursion below re-enters this
  // function for nested bodies, which is correct: a subshell gets its own scope.
  const vars = new Map<string, string>();
  const nested: string[] = [];
  const stripped = extractNested(command, depth, nested);
  const out: SimpleCommand[] = [];
  for (const body of nested) out.push(...parseCommands(body, depth + 1));
  for (const seg of splitSegments(stripped)) {
    const argv = tokenize(seg);
    if (!argv.length) continue;
    // Record literal assignments before stripping them, so a later segment's
    // `$R` can be resolved back to `rm`. `vars` is shared across the whole
    // command because a shell keeps assignments for the rest of the line.
    for (const tok of argv) {
      const m = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)(\+)?=([\s\S]*)$/);
      if (m) vars.set(m[1], stripQuotes(m[3]));
    }
    const effective = stripAssignments(argv);
    if (!effective.length) continue;
    out.push({ argv: expandVars(effective, vars), raw: seg });
    const name = commandName(effective[0]);
    if (!name) continue;
    // Unwrap wrappers that execute another command.
    if (NESTING_SHELLS.has(name)) {
      const rest = effective.slice(1);
      if (name === "xargs") {
        // Drop xargs' own options/placeholder, then recurse into the command.
        const inner = rest.filter((a, i) => i === 0 ? !a.startsWith("-") : !/^[{}]$/.test(a));
        if (inner.length) out.push(...parseCommands(inner.join(" "), depth + 1));
      } else if (name === "env" || name === "nohup" || name === "stdbuf" || name === "nice" || name === "timeout" || name === "watch" || name === "command" || name === "builtin") {
        const inner = stripAssignments(rest.filter((a) => !/^-/.test(a) || /^-[A-Za-z_]+=/.test(a)));
        if (inner.length) out.push(...parseCommands(inner.join(" "), depth + 1));
      } else {
        // sh/bash/zsh/sudo/doas/eval: everything after -c is a command string.
        const ci = rest.findIndex((a) => a === "-c" || a === "--login" || a === "-lc" || a === "-lic");
        if (ci >= 0 && rest[ci + 1]) out.push(...parseCommands(rest[ci + 1], depth + 1));
        else if (rest.length && !rest[0].startsWith("-")) {
          // `sudo rm -rf x` / `env FOO=1 rm -rf x` — recurse on the remainder.
          out.push(...parseCommands(rest.join(" "), depth + 1));
        }
      }
    }
  }
  return out;
}

/**
 * Why a command is destructive, or null when it is not.
 *
 * Kept separate from checkDestructiveCommand so callers can decide what to do
 * with a hit: "deny" formats a refusal, "ask" has to throw so the agent loop
 * can actually prompt a human. Returning a preformatted "PENDING" string for
 * both is what let "ask" silently do nothing.
 */
export function destructiveReason(command: string): string | null {
  for (const cmd of parseCommands(command)) {
    const reason = destructiveReasonFor(cmd);
    if (reason) return reason;
    // A redirect that can overwrite a file. `> /dev/null` and the tmp scratch
    // dirs are exempt, matching the previous behaviour.
    if (/(^|[^0-9<>])>{1,2}|\d>&/.test(cmd.raw)) {
      const target = cmd.raw.match(/>{1,2}\s*"?([^\s"';|&]+)"?/);
      const t = target?.[1] ?? "";
      const isScratch = t === "/dev/null" || t === "/dev/stdout" || t === "NUL" || t.startsWith("/tmp/") || t.startsWith("/var/tmp/") || t.startsWith("C:/Windows/Temp/") || t.startsWith("C:\\Windows\\Temp\\");
      if (!isScratch) return "output redirection (may overwrite files)";
    }
    // `tee` writes through to a file just as a redirect does.
    if (commandName(cmd.argv[0] ?? "") === "tee") return "tee writes to a file";
  }
  return null;
}

/**
 * Why a command would touch the network, or null when it would not.
 *
 * Classification only - no policy. Includes the obfuscation checks: the shell
 * expands `${IFS}` and friends before exec, so a wordlist over the raw string
 * misses `cur<TAB>l`, and matching the squashed argv word is the reliable
 * signal.
 */
export function networkReason(command: string): string | null {
  const cmds = parseCommands(command);
  for (const cmd of cmds) {
    const reason = networkReasonFor(cmd);
    if (reason) return reason;
  }
  // Field splitting: `curl${IFS}https://x`, `cur\tl`, `cur\nl`.
  for (const cmd of cmds) {
    const squashed = (cmd.argv[0] ?? "").replace(/[\s${}()]/g, "").toLowerCase();
    if (squashed && NETWORK_CMDS[squashed]) {
      return `${NETWORK_CMDS[squashed]} (obfuscated invocation)`;
    }
  }
  if (/\$\{?IFS\}?/.test(command)) {
    for (const cmd of cmds) {
      if (/\b(curl|wget|nc|ncat|ssh|scp|ftp|telnet|git|python3?|node|openssl)\b/i.test(cmd.raw)) {
        return "IFS-expanded network invocation";
      }
    }
  }
  return null;
}