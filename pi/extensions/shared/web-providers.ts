import { randomUUID } from "node:crypto";
import type { WebProvider } from "./extension-settings";

export type WebFailure = { provider: WebProvider | "direct"; error: string };
export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  providers: WebProvider[];
};
export type SearchResponse = {
  query: string;
  results: SearchResult[];
  providers: { provider: WebProvider; results: number }[];
  failures: WebFailure[];
};
export type WebPage = {
  url: string;
  title: string;
  text: string;
  format: "markdown" | "text";
  contentKind: "page" | "excerpts";
  provider: WebProvider | "direct";
};

const EXA_URL = "https://mcp.exa.ai/mcp";
const PARALLEL_URL = "https://search.parallel.ai/mcp";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2";
const KEENABLE_URL = "https://api.keenable.ai/v1";
const sessionId = randomUUID();
const REQUEST_TIMEOUT_MS = 30_000;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unexpected web response: expected an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function passages(value: unknown): string {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string").join("\n\n") : "";
}

export function webUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Web URLs must use http or https");
  }
  return url.href;
}

export async function requestWeb(url: string, init: RequestInit = {}): Promise<{
  text: string;
  url: string;
  contentType: string;
}> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(init.signal ? [init.signal] : []),
  ]);
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", "pi-console-web/0.1");
  const response = await fetch(url, { ...init, headers, signal });
  const body = await response.text();
  signal.throwIfAborted();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500) || response.statusText}`);
  return { text: body, url: response.url || url, contentType: response.headers.get("content-type") || "" };
}

async function postJson(url: string, body: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<unknown> {
  const response = await requestWeb(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  return JSON.parse(response.text);
}

async function callMcp(url: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await requestWeb(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal,
  });
  const body = response.text.trim();
  const payloads = body.startsWith("{") ? [body] : body.replace(/\r\n?/g, "\n").split("\n\n")
    .map(frame => frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"))
    .filter(Boolean);
  for (const payload of payloads) {
    const envelope = record(JSON.parse(payload));
    if (envelope.id !== 1) continue;
    if (envelope.error) throw new Error(text(record(envelope.error).message) || "MCP request failed");
    const result = record(envelope.result);
    const parts = Array.isArray(result.content) ? result.content.map(part => text(record(part).text)).filter(Boolean) : [];
    if (result.isError === true) throw new Error(parts.join("\n") || "MCP tool failed");
    if (result.structuredContent !== undefined) return result.structuredContent;
    const output = parts.join("\n");
    if (!output) throw new Error("MCP response contained no content");
    // Some fetch tools return Markdown, while search tools return JSON in a text block.
    try { return JSON.parse(output); } catch { return output; }
  }
  throw new Error("MCP response contained no matching result");
}

function checkResponse(value: unknown): Record<string, unknown> {
  const data = record(value);
  if (data.success === false || data.error) {
    throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error) || "Web provider failed");
  }
  return data;
}

async function searchProvider(provider: WebProvider, query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
  let response: unknown;
  switch (provider) {
    case "exa":
      response = await callMcp(`${EXA_URL}?tools=web_search_advanced_exa`, "web_search_advanced_exa", {
        query, numResults: limit, enableSummary: false, enableHighlights: false,
      }, signal);
      break;
    case "parallel":
      response = await callMcp(PARALLEL_URL, "web_search", {
        objective: query, search_queries: [query], session_id: sessionId,
      }, signal);
      break;
    case "firecrawl":
      response = await postJson(`${FIRECRAWL_URL}/search`, { query, limit }, signal);
      break;
    case "keenable":
      response = await postJson(`${KEENABLE_URL}/search/public`, { query, max_results: limit }, signal, {
        "X-Keenable-Title": "pi-console",
      });
      break;
  }
  const data = checkResponse(response);
  const rows = provider === "firecrawl" ? record(data.data).web : data.results;
  if (!Array.isArray(rows)) throw new Error("Unexpected search response: missing results array");
  return rows.map(row => {
    const item = record(row);
    const url = webUrl(text(item.url));
    const snippet = text(item.snippet) || text(item.description);
    const content = text(item.text) || text(item.markdown) || text(item.content) || passages(item.excerpts) || passages(item.highlights);
    return { title: text(item.title) || url, url, snippet, ...(content ? { content } : {}), providers: [provider] };
  });
}

export async function searchWeb(query: string, limit: number, providers: readonly WebProvider[], signal?: AbortSignal): Promise<SearchResponse> {
  signal?.throwIfAborted();
  const responses = await Promise.all(providers.map(async provider => {
    try {
      return { provider, results: await searchProvider(provider, query, limit, signal) };
    } catch (error) {
      signal?.throwIfAborted();
      return { provider, results: [], error: errorMessage(error) };
    }
  }));
  signal?.throwIfAborted();
  const merged = new Map<string, SearchResult>();
  const longest = Math.max(0, ...responses.map(response => response.results.length));
  // Round-robin preserves each provider's ordering without inventing a relevance score.
  for (let rank = 0; rank < longest; rank++) {
    for (const response of responses) {
      const result = response.results[rank];
      if (!result) continue;
      const url = new URL(result.url);
      url.hash = "";
      const key = url.href;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...result, url: key });
      } else {
        if (!existing.providers.includes(response.provider)) existing.providers.push(response.provider);
        if (result.snippet.length > existing.snippet.length) existing.snippet = result.snippet;
        if ((result.content?.length ?? 0) > (existing.content?.length ?? 0)) existing.content = result.content;
      }
    }
  }
  return {
    query,
    results: [...merged.values()].slice(0, limit),
    providers: responses.filter(response => response.error === undefined).map(({ provider, results }) => ({ provider, results: results.length })),
    failures: responses.filter(response => response.error !== undefined).map(response => ({ provider: response.provider, error: response.error! })),
  };
}

export async function extractWeb(provider: WebProvider, url: string, signal?: AbortSignal): Promise<WebPage> {
  let response: unknown;
  switch (provider) {
    case "exa":
      response = await callMcp(EXA_URL, "web_fetch_exa", { urls: [url] }, signal);
      if (typeof response === "string") {
        if (!response.trim()) throw new Error("Exa returned no page content");
        const header = response.split(/\n\s*\n/, 1)[0];
        const title = header.match(/^(?:# |Title:\s*)(.+)$/m)?.[1]?.trim() || "";
        const returnedUrl = header.match(/^URL:\s*(\S+)/m)?.[1];
        return { url: returnedUrl ? webUrl(returnedUrl) : url, title, text: response, format: "markdown", contentKind: "page", provider };
      }
      break;
    case "parallel":
      response = await callMcp(PARALLEL_URL, "web_fetch", { urls: [url], objective: "Full page content", session_id: sessionId }, signal);
      break;
    case "firecrawl":
      response = await postJson(`${FIRECRAWL_URL}/scrape`, { url, formats: ["markdown"] }, signal);
      break;
    case "keenable": {
      const result = await requestWeb(`${KEENABLE_URL}/fetch/public?${new URLSearchParams({ url })}`, {
        headers: { "X-Keenable-Title": "pi-console" }, signal,
      });
      response = JSON.parse(result.text);
      break;
    }
  }
  const data = checkResponse(response);
  let page: Record<string, unknown>;
  if (provider === "firecrawl") {
    page = record(data.data);
  } else if (provider === "exa" || provider === "parallel") {
    if (!Array.isArray(data.results) || data.results.length === 0) {
      throw new Error(`No extracted page: ${JSON.stringify(data.errors || data.statuses || [])}`);
    }
    page = checkResponse(data.results[0]);
  } else {
    page = data;
  }
  const metadata = page.metadata ? record(page.metadata) : {};
  if (typeof metadata.statusCode === "number" && metadata.statusCode >= 400) {
    throw new Error(`Extracted page returned HTTP ${metadata.statusCode}`);
  }
  const fullContent = text(page.markdown) || text(page.full_content) || text(page.content) || text(page.text);
  const content = fullContent || passages(page.excerpts);
  if (!content.trim()) throw new Error("Provider returned no page content");
  return {
    url: webUrl(text(page.url) || text(metadata.url) || text(metadata.sourceURL) || url),
    title: text(page.title) || text(metadata.title),
    text: content,
    format: provider === "keenable" || !fullContent ? "text" : "markdown",
    contentKind: fullContent ? "page" : "excerpts",
    provider,
  };
}
