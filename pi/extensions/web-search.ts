import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

function decodeHtml(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(s: string) {
  return decodeHtml(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function unwrapDuckUrl(raw: string) {
  const decoded = decodeHtml(raw);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return decoded;
  }
}

async function fetchText(url: string, signal?: AbortSignal) {
  const res = await fetch(url, {
    signal,
    headers: {
      "user-agent": "pi-ddg-web-extension/0.1",
      "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRe = /<div class="result[\s\S]*?<\/div>\s*<\/div>/gi;
  const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;

  for (const block of html.match(blockRe) ?? []) {
    const title = titleRe.exec(block);
    if (!title) continue;

    const snippet = snippetRe.exec(block);
    results.push({
      title: stripTags(title[2]),
      url: unwrapDuckUrl(title[1]),
      snippet: snippet ? stripTags(snippet[1]) : "",
    });

    if (results.length >= limit) break;
  }

  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web with DuckDuckGo HTML search.",
    promptSnippet: "Search the web via DuckDuckGo and return titles, URLs, and snippets.",
    promptGuidelines: [
      "Use web_search when the user asks for current, external, or web-sourced information.",
      "Cite URLs from web_search or web_fetch when answering factual web questions.",
    ],
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      const limit = Math.min(Math.max(params.limit ?? 5, 1), 10);
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;
      const html = await fetchText(url, signal);
      const results = parseDuckDuckGo(html, limit);

      return {
        content: [{ type: "text", text: JSON.stringify({ query: params.query, results }, null, 2) }],
        details: { results },
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL and return cleaned page text.",
    promptSnippet: "Fetch and clean a web page into readable text.",
    promptGuidelines: [
      "Use web_fetch to inspect specific URLs returned by web_search before relying on them.",
    ],
    parameters: Type.Object({
      url: Type.String(),
      maxChars: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      const maxChars = Math.min(Math.max(params.maxChars ?? 12000, 1000), 50000);
      const html = await fetchText(params.url, signal);
      const text = stripTags(html).slice(0, maxChars);

      return {
        content: [{ type: "text", text: JSON.stringify({ url: params.url, text }, null, 2) }],
        details: { url: params.url, text },
      };
    },
  });
}
