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
          timeoutMs: { type: "number", description: "Timeout in milliseconds (optional, default 20000)" },
        },
        required: ["url"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//i.test(url)) return `ERROR: unsupported URL (must be http or https): ${url}`;
    const maxChars = Math.max(100, Number(args.maxChars ?? 4000) || 4000);
    const timeoutMs = Math.max(1000, Number(args.timeoutMs ?? 20000) || 20000);

    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    const onAbort = () => ac.abort();
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { redirect: "follow", signal: ac.signal });
      if (!res.ok) return `ERROR: HTTP ${res.status} ${res.statusText}`;
      const ctype = res.headers.get("content-type") ?? "";

      // Stream the body and stop as soon as we have enough text, so a huge
      // response (downloaded log, generated file, …) never loads fully into
      // memory or blocks the turn.
      const announced = Number(res.headers.get("content-length"));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let body = "";
      let bytesRead = 0;
      let hitCap = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value?.byteLength ?? 0;
          body += decoder.decode(value, { stream: true });
          if (body.length >= maxChars) {
            hitCap = true;
            break;
          }
        }
      } finally {
        if (hitCap) await reader.cancel?.().catch(() => {});
        reader.releaseLock?.();
      }

      const fullLen = Number.isFinite(announced) && announced > 0 ? Math.max(announced, bytesRead) : bytesRead;
      const truncated = fullLen > maxChars ? "\n...(truncated, more available via maxChars)" : "";
      return `HTTP ${res.status} · content-type: ${ctype} · bytes: ${fullLen}${truncated}\n${body.slice(0, maxChars)}`;
    } catch (err: any) {
      if (timedOut) return `ERROR: fetch timed out after ${timeoutMs}ms`;
      if (ac.signal.aborted) return "ERROR: fetch aborted";
      return `ERROR: fetch failed: ${err?.message ?? String(err)}`;
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
});