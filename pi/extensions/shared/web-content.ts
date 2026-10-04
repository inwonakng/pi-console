import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { WebProvider } from "./extension-settings";
import { errorMessage, extractWeb, requestWeb, webUrl, type WebFailure, type WebPage } from "./web-providers";

const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
markdown.use(gfm);

export function extractHtml(html: string, url: string): Pick<WebPage, "title" | "text" | "format"> {
  const { document } = parseHTML(html);
  if (document.querySelector("#challenge-form, #cf-challenge-running")
    || /^(just a moment|captcha|verify you are human|access denied)\b/i.test(document.title.trim())) {
    throw new Error("Page requires verification");
  }
  let base = url;
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try { base = webUrl(new URL(baseHref, url).href); } catch { /* Use the fetched URL when the base is invalid. */ }
  }
  document.querySelectorAll("script, style, noscript, template, nav, footer, form, iframe, svg, [hidden], [aria-hidden='true']")
    .forEach(node => node.remove());
  for (const [selector, attribute] of [["a[href]", "href"], ["img[src]", "src"]] as const) {
    for (const node of document.querySelectorAll(selector)) {
      try {
        const target = new URL(node.getAttribute(attribute)!, base);
        if (target.protocol === "javascript:" || target.protocol === "data:") node.removeAttribute(attribute);
        else node.setAttribute(attribute, target.href);
      } catch {
        node.removeAttribute(attribute);
      }
    }
  }
  let title = document.title.trim();
  let result = "";
  for (const main of document.querySelectorAll("main, article, [role='main']")) {
    result = markdown.turndown(main.innerHTML).trim();
    if (result) break;
  }
  if (!result) {
    // Readability mutates its input; keep the original body available as a fallback.
    try {
      const article = new Readability(document.cloneNode(true) as Document).parse();
      if (article?.content) {
        result = markdown.turndown(article.content).trim();
        title = article.title || title;
      }
    } catch {
      // An unsupported DOM shape should not prevent conversion of the original body.
    }
  }
  if (!result) result = markdown.turndown(document.body.innerHTML).trim();
  if (!result) throw new Error("Page contained no readable content");
  return { title, text: result, format: "markdown" };
}

async function fetchDirect(url: string, signal?: AbortSignal): Promise<WebPage> {
  const response = await requestWeb(url, {
    signal,
    headers: { accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8" },
  });
  const mime = response.contentType.split(";", 1)[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml" || (!mime && /<(?:!doctype|html|head|body)\b/i.test(response.text))) {
    return { url: response.url, ...extractHtml(response.text, response.url), contentKind: "page", provider: "direct" };
  }
  if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime === "application/xml" || mime.endsWith("+xml")) {
    if (!response.text.trim()) throw new Error("Page contained no content");
    return { url: response.url, title: "", text: response.text, format: mime === "text/markdown" ? "markdown" : "text", contentKind: "page", provider: "direct" };
  }
  throw new Error(`Direct extraction does not support ${mime || "an unknown content type"}`);
}

export async function fetchPage(url: string, providers: readonly WebProvider[], signal?: AbortSignal): Promise<WebPage & { failures: WebFailure[] }> {
  const target = webUrl(url);
  signal?.throwIfAborted();
  const failures: WebFailure[] = [];
  try {
    const page = await fetchDirect(target, signal);
    signal?.throwIfAborted();
    return { ...page, failures };
  } catch (error) {
    signal?.throwIfAborted();
    failures.push({ provider: "direct", error: errorMessage(error) });
  }
  for (const provider of providers) {
    try {
      const page = await extractWeb(provider, target, signal);
      signal?.throwIfAborted();
      return { ...page, failures };
    } catch (error) {
      signal?.throwIfAborted();
      failures.push({ provider, error: errorMessage(error) });
    }
  }
  throw new Error(`All page fetches failed: ${failures.map(failure => `${failure.provider}: ${failure.error}`).join("; ")}`);
}
