import { registerTool, type ToolContext } from "./registry";

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
    const bin = Bun.spawn({
      cmd: ["which", "tailscale"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
      detached: true,
    });
    const [whichOut, whichErr, whichExit] = await Promise.all([
      new Response(bin.stdout).text(),
      new Response(bin.stderr).text(),
      bin.exited,
    ]);
    if (whichExit !== 0 || !whichOut.trim()) {
      return "ERROR: tailscale not found on PATH — install it: https://tailscale.com/download (or termux: pkg install tailscale)";
    }

    // Full status: tailscale status --json is the most reliable machine-readable
    // form; the plain `tailscale status` is human-readable. Prefer JSON when
    // available, fall back to plain.
    const useJson = wantSummary;
    const proc = Bun.spawn({
      cmd: useJson ? ["tailscale", "status", "--json"] : ["tailscale", "status"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
      detached: true,
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += stderr ? (output ? "\n" : "") + stderr : "";
      if (exitCode !== 0) output += (output ? "\n" : "") + `[exit code: ${exitCode}]`;

      if (useJson && stdout) {
        try {
          const j = JSON.parse(stdout);
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
    } catch (err: any) {
      return `ERROR: tailscale status failed: ${err?.message ?? String(err)}`;
    }
  },
});
