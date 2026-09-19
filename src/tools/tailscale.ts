import { registerTool, type ToolContext } from "./registry";
import { spawnCollect } from "./proc";

/**
 * Check Tailscale tunnel health. Reports whether the machine is connected to
 * the tailnet, the exit node / gateway status, and the IPs assigned. Useful
 * when vibecoder needs to reach a server on another device (e.g. your Oppo
 * server at 100.x.x.x) — the agent can check tailscale status before trying
 * to connect. Inert when tailscale isn't installed.
 */
registerTool({
  definition: {
    type: "function",
    function: {
      name: "tailscale_status",
      description:
        "Check Tailscale tunnel status: whether connected, the machine's tailnet IP, peer devices, and any upstream exit node / ACL status. Returns the full `tailscale status` output (or a concise summary if the output is large). Inert when tailscale isn't installed.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "boolean",
            description: "When true, return only a short human-readable summary (connected + tailnet IP + peer count) instead of the full table.",
          },
        },
        required: [],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const wantSummary = Boolean(args.summary);

    // Check that tailscale is available.
    const which = await spawnCollect({
      cmd: ["which", "tailscale"],
      env: { ...process.env, NO_COLOR: "1" } as Record<string, string>,
      timeoutMs: 15_000,
      signal: ctx.signal,
    });
    if (which.exitCode !== 0 || !which.stdout.trim()) {
      return "ERROR: tailscale not found on PATH — install it: https://tailscale.com/download (or termux: pkg install tailscale)";
    }

    // Full status: tailscale status --json is the most reliable machine-readable
    // form; the plain `tailscale status` is human-readable. Prefer JSON when
    // available, fall back to plain.
    const useJson = wantSummary;
    const res = await spawnCollect({
      cmd: useJson ? ["tailscale", "status", "--json"] : ["tailscale", "status"],
      env: { ...process.env, NO_COLOR: "1" } as Record<string, string>,
      timeoutMs: 30_000,
      signal: ctx.signal,
    });

    let output = "";
    if (res.stdout) output += res.stdout;
    if (res.stderr) output += res.stderr ? (output ? "\n" : "") + res.stderr : "";
    if (res.timedOut) output += (output ? "\n" : "") + "[killed: timed out]";
    if (res.aborted) output += (output ? "\n" : "") + "[killed: interrupted]";
    if (res.exitCode < 0) {
      return `ERROR: tailscale status failed: ${res.stderr.trim() || "could not be spawned"}`;
    }
    if (!res.timedOut && !res.aborted && res.exitCode !== 0) {
      output += (output ? "\n" : "") + `[exit code: ${res.exitCode}]`;
    }

    if (useJson && res.stdout) {
      try {
        const j = JSON.parse(res.stdout);
        const dnsName = j.dnsName ?? "(no dnsName)";
        const magicSrc = j.magicDNSSrcIP ?? "(no magicDNSSrcIP)";
        const selfPeer = j.Self ?? null;
        const peerIps = (selfPeer?.MagicDNSSrcIP
          ? [(selfPeer.MagicDNSSrcIP ?? "").replace(/\.(\d+)$/, "") + ".local"]
          : [])
          .concat(selfPeer?.TailscaleIPs ?? [])
          .filter(Boolean);
        const peers = j.Peers ?? {};
        const peerCount = Object.keys(peers).length;
        const onlinePeers = Object.values(peers).filter((p: any) => p.Online === true).length;
        return [
          `tailscale: ${j.CanCarryPossibly ? "connected" : "not connected"}${j.BackendState ? ` (backend: ${j.BackendState})` : ""}`,
          `  hostname: ${dnsName}`,
          `  tailnet IP: ${peerIps.join(", ") || "(none)"}`,
          `  peers: ${peerCount} total, ${onlinePeers} online`,
          j.BackendState === "Connecting"
            ? "  ⚠ still connecting — give it a moment"
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      } catch {
        // JSON parse failed — fall through to returning the raw output.
      }
    }
    return output || "(no output)";
  },
});