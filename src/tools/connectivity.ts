import { registerTool, type ToolContext } from "./registry";

/**
 * Local network diagnostics for the laptop this agent runs on. Performs
 * capped, best-effort checks: ping a host, resolve a hostname via DNS,
 * probe an HTTP(S) URL, discover the LAN gateway, and produce a one-line
 * summary. Use before the agent reaches out to another host (server, peer,
 * API endpoint) so it knows whether the network path is alive first.
 *
 * Each sub-check is inert when the needed binary is missing — returns a
 * clear note, never throws.
 */
registerTool({
  definition: {
    type: "function",
    function: {
      name: "network_check",
      description:
        "Run a capped local network diagnostic: ping a host, resolve its DNS, probe an HTTP(S) URL, discover the LAN gateway, and return a one-line summary. Use before reaching out to another host so the agent knows the network path is alive. Each sub-check is inert when the needed binary is missing.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "Hostname or IP to ping + DNS-resolve + HTTP-probe (optional)" },
          url: { type: "string", description: "HTTP(S) URL to probe (optional, overrides host if both given)" },
          summaryOnly: { type: "boolean", description: "When true, return only the one-line summary (default false)" },
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const host = String(args.host ?? "").trim();
    const url = String(args.url ?? "").trim();
    const summaryOnly = Boolean(args.summaryOnly);

    // Resolve target for ping + DNS + HTTP.
    const target = url || host;
    if (!target) return "ERROR: host or url is required";

    const results: string[] = [];
    const checks: string[] = [];

    // 1) Ping (capped: 3 packets, 5s).
    if (host) {
      const ping = await pingHost(ctx, host);
      results.push(ping);
      checks.push("ping");
    }

    // 2) DNS resolve (dig or getent or node net).
    if (host && host !== target) {
      // Only resolve the separate host arg if it differs from the url.
    }
    const dns = await resolveDNS(ctx, host || target);
    results.push(dns);
    checks.push("dns");

    // 3) HTTP probe (capped fetch).
    if (url) {
      const http = await probeHTTP(ctx, url);
      results.push(http);
      checks.push("http");
    } else if (/^https?:\/\//i.test(host || "")) {
      const http = await probeHTTP(ctx, host!);
      results.push(http);
      checks.push("http");
    }

    // 4) LAN gateway.
    const gateway = await lanGateway(ctx);
    results.push(gateway);
    checks.push("gateway");

    const summary = buildSummary(checks, results);
    if (summaryOnly) return summary;
    return [summary, "", ...results].join("\n");
  },
});

// ── sub-checks ─────────────────────────────────────────────────────────────────

async function pingHost(ctx: ToolContext, host: string): Promise<string> {
  try {
    const proc = Bun.spawn({
      cmd: ["ping", "-c", "3", "-W", "5", host],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
      detached: true,
      signal: ctx.signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let out = "";
    if (stdout) out += stdout;
    if (stderr) out += (out ? "\n" : "") + stderr;
    if (exitCode !== 0 && !stdout) out += (out ? "\n" : "") + `[exit code: ${exitCode}]`;
    const avg = stdout.match(/rtt[mina-z0-9 ]+=\s*([\d.]+)\/mu\/?l/gi)?.[0]?.slice(/\d/.test(stdout[0]) ? 0 : 0) ?? "";
    return `ping ${host}: ${exitCode === 0 ? "reachable" : "unreachable"}${avg ? " (avg " + avg.split("=")[1].trim() + " ms)" : ""}`;
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "message" in err ? (err as Record<string, unknown>).message : String(err);
    return `ping ${host}: unavailable (${msg})`;
  }
}

async function resolveDNS(ctx: ToolContext, host: string): Promise<string> {
  // Try dig first, then getent, then node net.lookup.
  if (await binaryExists(ctx, "dig")) {
    try {
      const proc = Bun.spawn({
        cmd: ["dig", "+short", host],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
        detached: true,
        signal: ctx.signal,
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      const ips = stdout.trim().split("\n").filter(Boolean);
      if (ips.length) return `dns ${host}: ${ips.join(", ")}`;
      return `dns ${host}: no records (dig returned empty)`;
    } catch {
      // fall through
    }
  }
  if (await binaryExists(ctx, "getent")) {
    try {
      const proc = Bun.spawn({
        cmd: ["getent", "hosts", host],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
        detached: true,
        signal: ctx.signal,
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length) {
        // getent hosts: "IP hostname [alias...]"
        const ips = lines.map((l) => l.split(/\s+/)[0]).filter(Boolean);
        return `dns ${host}: ${ips.join(", ")}`;
      }
      return `dns ${host}: no records (getent returned empty)`;
    } catch {
      // fall through
    }
  }
  // Node fallback.
  try {
    const { lookup } = await import("node:dns");
    const result = await new Promise<string[]>((resolve, reject) => {
      lookup(host, { all: true }, (err, addresses) => {
        if (err) reject(err); else resolve(addresses?.map((a) => a.address) ?? []);
      });
    });
    if (result.length) return `dns ${host}: ${result.join(", ")}`;
    return `dns ${host}: no records (node lookup returned empty)`;
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "message" in err ? (err as Record<string, unknown>).message : String(err);
    return `dns ${host}: unavailable (${msg})`;
  }
}

async function probeHTTP(ctx: ToolContext, url: string): Promise<string> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(url, { method: "HEAD", signal: ac.signal });
    clearTimeout(timer);
    const status = res.status;
    const reachable = status >= 200 && status < 500;
    return `http ${new URL(url).hostname}: ${status} ${reachable ? "reachable" : "error"}`;
  } catch (err: unknown) {
    const msg = err && typeof err === "object" && "message" in err ? String((err as Record<string, unknown>).message) : String(err);
    // Distinguish network error from HTTP error.
    const msgStr = msg;
    if (msgStr.includes("abort") || msgStr.includes("timed out")) {
      return `http ${new URL(url).hostname}: timed out / unreachable`;
    }
    return `http ${new URL(url).hostname}: unreachable (${msg})`;
  }
}

async function lanGateway(ctx: ToolContext): Promise<string> {
  // Try ip route, then netstat -rn, then node networkInterfaces for a reasonable guess.
  if (await binaryExists(ctx, "ip")) {
    try {
      const proc = Bun.spawn({
        cmd: ["ip", "route"],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
        detached: true,
        signal: ctx.signal,
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      const lines = stdout.split("\n").filter((l) => l.startsWith("default via"));
      if (lines.length) {
        const gw = lines[0].split(/\s+/)[2];
        return `lan gateway: ${gw}`;
      }
      return "lan gateway: (no default route found)";
    } catch {
      // fall through
    }
  }
  if (await binaryExists(ctx, "netstat")) {
    try {
      const proc = Bun.spawn({
        cmd: ["netstat", "-rn"],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
        detached: true,
        signal: ctx.signal,
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      const lines = stdout.split("\n").filter((l) => l.startsWith("default"));
      if (lines.length) {
        const gw = lines[0].split(/\s+/)[1];
        return `lan gateway: ${gw}`;
      }
      return "lan gateway: (no default route found)";
    } catch {
      // fall through
    }
  }
  // Node fallback: pick the interface with a default route guess via the OS route table is not possible; return the primary non-local IP instead.
  try {
    const { networkInterfaces } = await import("node:os");
    const ifs = networkInterfaces();
    for (const name of Object.keys(ifs)) {
      if (name === "Loopback" || name.startsWith("Loopback")) continue;
      for (const iface of ifs[name] ?? []) {
        if (iface.family === "IPv4" && !iface.internal && iface.address) {
          return `lan gateway: (could not determine — primary IPv4 on ${name}: ${iface.address})`;
        }
      }
    }
    return "lan gateway: (no non-loopback IPv4 interface found)";
  } catch {
    return "lan gateway: unavailable";
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

async function binaryExists(ctx: ToolContext, name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: ["which", name],
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      signal: ctx.signal,
    });
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return exitCode === 0 && out.trim().length > 0;
  } catch {
    return false;
  }
}

function buildSummary(checks: string[], results: string[]): string {
  const lines: string[] = [];
  const pingOk = results[0]?.includes("reachable") ?? false;
  const dnsOk = (results[1]?.includes(": ") && !results[1]?.includes("unavailable") && !results[1]?.includes("no records")) ?? false;
  const httpOk = results[2]?.includes("reachable") ?? false;
  const gwOk = (results[3]?.includes(": ") && !results[3]?.includes("unavailable")) ?? false;
  lines.push(`network: ${checks.length} checks · ${[
    pingOk ? "ping ok" : "ping fail",
    dnsOk ? "dns ok" : "dns fail",
    checks.includes("http") ? (httpOk ? "http ok" : "http fail") : "http n/a",
    gwOk ? "gateway ok" : "gateway fail",
  ].filter(Boolean).join(", ")}`);
  return lines.join("\n");
}
