import { registerTool, type ToolContext } from "./registry";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

registerTool({
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web using DuckDuckGo. Returns top results with titles, URLs, and snippets. Useful for finding documentation, libraries, news, or any information not available locally.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: { type: "number", description: "Max results to return (optional, default 5, max 10)" },
        },
        required: ["query"],
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const query = String(args.query ?? "").trim();
    if (!query) return "ERROR: query is required";
    const maxResults = Math.min(10, Math.max(1, Number(args.maxResults ?? 5) || 5));

    // Use DuckDuckGo Instant Answer API first (clean JSON, no scraping)
    try {
      const instantUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const instantRes = await fetch(instantUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: ctx.signal,
      });
      if (instantRes.ok) {
        const data = (await instantRes.json()) as Record<string, unknown>;
        const abstract = data.Abstract as string | undefined;
        const heading = (data as { Heading?: string }).Heading as string | undefined;
        const image = data.Image as string | undefined;
        const redirect = data.RelatedTopics as Array<{ FirstURL?: string; Text?: string; Topics?: Array<{ FirstURL?: string; Text?: string }> }> | undefined;

        const parts: string[] = [];
        if (heading) parts.push(`# ${heading}`);
        if (abstract) parts.push(`\n${abstract}`);
        if (image) parts.push(`\nImage: ${image}`);

        const related: Array<{ url: string; text: string }> = [];
        if (Array.isArray(redirect)) {
          for (const r of redirect) {
            if (r.Topics) {
              for (const t of r.Topics) {
                if (t.FirstURL && t.Text) related.push({ url: t.FirstURL, text: t.Text.replace(/<[^>]+>/g, "") });
              }
            } else if (r.FirstURL && r.Text) {
              related.push({ url: r.FirstURL, text: r.Text.replace(/<[^>]+>/g, "") });
            }
          }
        }

        if (related.length) {
          parts.push(`\n## Results (${related.length}):`);
          for (let i = 0; i < Math.min(maxResults, related.length); i++) {
            const r = related[i];
            parts.push(`  ${i + 1}. [${r.text.slice(0, 120)}](${r.url})`);
          }
        }

        return parts.join("\n") || "No results found";
      }
    } catch (_) {
      // fall through to scraping
    }

    // Fallback: scrape DuckDuckGo HTML results
    try {
      const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const htmlRes = await fetch(htmlUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: ctx.signal,
      });
      if (!htmlRes.ok) return `ERROR: search failed (HTTP ${htmlRes.status})`;

      const html = await htmlRes.text();
      // Parse result links from DuckDuckGo HTML
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

      let match;
      const titles: Array<{ url: string; text: string }> = [];
      while ((match = linkRegex.exec(html)) !== null) {
        let url = match[1];
        // DuckDuckGo wraps URLs in redirect links
        const uMatch = url.match(/uddg=([^&]+)/);
        if (uMatch) {
          try { url = decodeURIComponent(uMatch[1]); } catch { /* keep original */ }
        }
        titles.push({ url, text: match[2].replace(/<[^>]+>/g, "").trim() });
      }

      while ((match = snippetRegex.exec(html)) !== null) {
        const snippet = match[1].replace(/<[^>]+>/g, "").trim();
        if (results.length < titles.length) {
          results.push({ title: titles[results.length].text, url: titles[results.length].url, snippet });
        }
      }
      // Fill any missing snippets
      for (let i = 0; i < titles.length; i++) {
        if (i >= results.length) {
          results.push({ title: titles[i].text, url: titles[i].url, snippet: "" });
        }
      }

      if (!results.length) return "No results found";

      const out = [`## Search: ${query}`, `(${results.length} results, showing ${Math.min(maxResults, results.length)})`, ""];
      for (let i = 0; i < Math.min(maxResults, results.length); i++) {
        const r = results[i];
        out.push(`${i + 1}. **${r.title}**`);
        out.push(`   ${r.url}`);
        if (r.snippet) out.push(`   ${r.snippet.slice(0, 200)}`);
        out.push("");
      }
      return out.join("\n");
    } catch (err: any) {
      return `ERROR: search failed: ${err?.message ?? String(err)}`;
    }
  },
});
