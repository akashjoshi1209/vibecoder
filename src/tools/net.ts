import { registerTool, type ToolContext } from "./registry";

registerTool({
  definition: {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch a URL (HTTP/HTTPS) and return its body as text, truncated to maxChars. Use to read documentation, API responses, or any web content.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          maxChars: { type: "number", description: "Max characters to return (optional, default 4000)" },
        },
        required: ["url"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//i.test(url)) return `ERROR: unsupported URL (must be http or https): ${url}`;
    const maxChars = Math.max(100, Number(args.maxChars ?? 4000) || 4000);

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { redirect: "follow", signal: ac.signal });
      if (!res.ok) return `ERROR: HTTP ${res.status} ${res.statusText}`;
      const full = await res.text();
      const ctype = res.headers.get("content-type") ?? "";
      const body = full.slice(0, maxChars);
      const truncated = full.length > maxChars ? "\n...(truncated, more available via maxChars)" : "";
      return `HTTP ${res.status} · content-type: ${ctype} · bytes: ${full.length}${truncated}\n${body}`;
    } catch (err: any) {
      if (ac.signal.aborted) return "ERROR: fetch aborted";
      return `ERROR: fetch failed: ${err?.message ?? String(err)}`;
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
});