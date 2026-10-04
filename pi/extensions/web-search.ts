import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadExtensionSettings, WEB_PROVIDERS } from "./shared/extension-settings";
import { fetchPage } from "./shared/web-content";
import { searchWeb } from "./shared/web-providers";

function configuredProviders() {
  return loadExtensionSettings()["web-search"]?.providers ?? WEB_PROVIDERS;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web through multiple free, keyless providers and merge their results. Returns titles, URLs, available excerpts or page content, provider provenance, and any provider failures.",
    promptSnippet: "Search the web and return merged results with source URLs and available content.",
    promptGuidelines: [
      "Use web_search when the user asks for current, external, or web-sourced information.",
      "Cite URLs from web_search or web_fetch when answering factual web questions.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum merged results (default: 5)." })),
    }),
    async execute(_id, params, signal) {
      if (!params.query.trim()) throw new Error("Search query must not be blank");
      const response = await searchWeb(params.query, params.limit ?? 5, configuredProviders(), signal);
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        details: response,
        isError: response.providers.length === 0,
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL and extract readable Markdown or text, preserving links and document structure. Tries direct retrieval first, then keyless hosted extraction. Reports provider, requested/returned URLs, and explicit truncation metadata.",
    promptSnippet: "Fetch a web page as readable Markdown or text, with hosted extraction fallback.",
    promptGuidelines: [
      "Use web_fetch to inspect specific URLs returned by web_search before relying on them.",
    ],
    parameters: Type.Object({
      url: Type.String(),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, description: "Maximum returned characters (default: 12000)." })),
    }),
    async execute(_id, params, signal) {
      const page = await fetchPage(params.url, configuredProviders(), signal);
      const maxChars = params.maxChars ?? 12000;
      const response = {
        ...page,
        requestedUrl: params.url,
        text: page.text.slice(0, maxChars),
        truncated: page.text.length > maxChars,
        totalChars: page.text.length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        details: response,
      };
    },
  });
}
