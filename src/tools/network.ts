import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";

/**
 * Tailscale tunnel health check. Reports whether this device is connected
 * to the tailnet, its tailnet name/IP, and known peer devices (name + IP).
 * Use before the agent tries to reach a server on another device (e.g. an
 * Oppo home server at a tailnet IP) — if the tunnel is down, tell the user
 * rather than guessing an unreachable LAN IP.
 *
 * Uses `tailscale status --json` when available (machine-readable), falls
 * back to plain `tailscale status`, and is inert when `tailscale` isn't on
 * PATH.
 */
registerTool({
  definition: {
    type: "function",
    function: {
      name: "tailscale_status",
      description:
        "Check Tailscale tunnel health: connected or not, this device's tailnet name/IP, and known peer machines (name + IP). Use before the agent tries to reach a server on another device (e.g. an Oppo home server). Inert when `tailscale` isn't installed.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "Optional: filter to a specific peer hostname (e.g. 'oppo-a9'). Returns its line, or 'not found'." },
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const host = String(args.host ?? "").trim();
    const env = { ...process.env, NO_COLOR: "1" } as Record<string, string>;

    // Confirm the binary exists. spawnCollect never throws: a missing binary
    // surfaces as a non-zero exit code, which means "not installed" here.
    const which = await spawnCollect({ cmd: ["which", "tailscale"], env, timeoutMs: 15_000, signal: ctx.signal });
    const hasBin = which.exitCode === 0 && which.stdout.trim().length > 0;
    if (!hasBin) {
      return "NOTE: tailscale not found on PATH. Install it: https://tailscale.com/download (or pkg install tailscale on Termux).";
    }

    let lastErr = "";

    async function tryJson(): Promise<string | null> {
      const proc = await spawnCollect({ cmd: ["tailscale", "status", "--json"], env, timeoutMs: 30_000, signal: ctx.signal });
      lastErr = proc.stderr || "(no stderr)";
      if (proc.exitCode !== 0 || !proc.stdout.trim()) return null;
      try {
        const j = JSON.parse(proc.stdout.trim());
        if (host) {
          const peer = j.Peers?.[host];
          if (!peer) {
            const known = Object.keys(j.Peers ?? {})
              .filter((k) => k)
              .map((k) => `  ${k} → ${(j.Peers[k]?.TailscaleIPs ?? []).join(", ") || "(no IP)"}`)
              .join("\n");
            return `Peer "${host}" not found. Known peers:\n${known || "(none)"}`;
          }
          const ips = (peer.TailscaleIPs ?? []).filter(Boolean);
          return `${host} → ${ips.join(", ") || "(no IP)"} · online: ${peer.Online}`;
        }
        const hostname = j.HostInfo?.HostName ?? "(unknown hostname)";
        const selfIps = (j.Self?.TailscaleIPs ?? []).filter(Boolean);
        const peers = j.Peers ?? {};
        const peerList = Object.entries(peers)
          .filter(([k]) => !!k)
          .map(([k, p]) => `  ${k} → ${((p as any).TailscaleIPs ?? []).join(", ") || "(no IP)"} ${((p as any).Online) ? "" : "(offline)"}`)
          .join("\n");
        const connected = j.BackendState === "Running" || (j.CanCarryPossibly === true);
        if (!peerList) return [
          `tailscale: ${connected ? "connected" : "NOT connected"}`,
          `  hostname: ${hostname}`,
          `  self IP: ${selfIps.join(", ") || "(no tailnet IP)"}`,
          "  peers: (none visible)",
        ].join("\n");
        return [
          `tailscale: ${connected ? "connected" : "NOT connected"}`,
          `  hostname: ${hostname}`,
          `  self IP: ${selfIps.join(", ") || "(no tailnet IP)"}`,
          `  peers: ${Object.keys(peers).length} total, ${Object.values(peers).filter((p: any) => p.Online).length} online`,
          peerList,
        ].join("\n");
      } catch {
        return null;
      }
    }

    // JSON first; fall back to plain status on failure.
    const jsonOut = await tryJson();
    if (jsonOut) return jsonOut;

    // Plain fallback.
    const plain = await spawnCollect({ cmd: ["tailscale", "status"], env, timeoutMs: 30_000, signal: ctx.signal });
    let text = "";
    if (plain.stdout) text += plain.stdout;
    if (plain.stderr) text += (text ? "\n" : "") + plain.stderr;
    if (plain.timedOut) text += (text ? "\n" : "") + "[killed: timed out]";
    if (plain.aborted) text += (text ? "\n" : "") + "[killed: interrupted]";
    if (plain.exitCode < 0) return `ERROR: tailscale status failed: ${plain.stderr.trim() || "could not be spawned"}`;
    if (!plain.timedOut && !plain.aborted && plain.exitCode !== 0) text += (text ? "\n" : "") + `[exit code: ${plain.exitCode}]`;
    if (text) return text;
    return lastErr || "(no output)";
  },
});

/**
 * Ping a host (best-effort, capped: 3 packets, 5s timeout). Use for quick
 * connectivity checks before attempting heavier operations. Returns ping
 * result, or a note if ping isn't available.
 */
registerTool({
  definition: {
    type: "function",
    function: {
      name: "network_ping",
      description:
        "Ping a host with a cap (3 packets, 5s timeout) to check basic connectivity. Returns the ping output, or a note if ping isn't available.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "Hostname or IP to ping (required)" },
        },
        required: ["host"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const host = String(args.host ?? "").trim();
    if (!host) return "ERROR: host is required";
    const env = { ...process.env, NO_COLOR: "1" } as Record<string, string>;
    const proc = await spawnCollect({
      cmd: ["ping", "-c", "3", "-W", "5", host],
      env,
      timeoutMs: 20_000,
      signal: ctx.signal,
    });
    if (proc.exitCode < 0) return `NOTE: ping not available: ${proc.stderr.trim() || "could not be spawned"}`;
    let out = "";
    if (proc.stdout) out += proc.stdout;
    if (proc.stderr) out += (out ? "\n" : "") + proc.stderr;
    if (proc.timedOut) out += (out ? "\n" : "") + "[killed: timed out]";
    if (proc.aborted) out += (out ? "\n" : "") + "[killed: interrupted]";
    if (!proc.timedOut && !proc.aborted && proc.exitCode !== 0) out += (out ? "\n" : "") + `[exit code: ${proc.exitCode}]`;
    return out || `(ping ${host})`;
  },
});
