// Marked 18.0.11 (MIT), vendored from the version in server/package-lock.json.
import { lexer } from "./vendor/marked.js";

function element(tag, content) {
  const node = document.createElement(tag);
  if (content) node.append(content);
  return node;
}
function decodeEntities(value) {
  const textarea = document.createElement("textarea");
  // Only character references are interpreted; markup never enters the DOM.
  textarea.innerHTML = value.replace(/</g, "&lt;");
  return textarea.value;
}
function linkTarget(href) {
  try {
    const url = new URL(decodeEntities(href), location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
function codeBlock(value) {
  const button = element("button", "Copy");
  button.type = "button";
  button.setAttribute("aria-label", "Copy code");
  button.setAttribute("aria-live", "polite");
  let resetTimer;
  button.addEventListener("click", async () => {
    clearTimeout(resetTimer);
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    } finally {
      button.disabled = false;
      button.setAttribute("aria-label", button.textContent);
      resetTimer = setTimeout(() => {
        button.textContent = "Copy";
        button.setAttribute("aria-label", "Copy code");
      }, 2000);
    }
  });
  const toolbar = element("div", button);
  toolbar.className = "code-block-toolbar";
  const wrapper = element("div", toolbar);
  wrapper.className = "code-block";
  wrapper.append(element("pre", element("code", document.createTextNode(value))));
  return wrapper;
}
function renderTokens(tokens) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    switch (token.type) {
      case "space": case "def": break;
      case "text":
        fragment.append(token.tokens ? renderTokens(token.tokens) : document.createTextNode(decodeEntities(token.text)));
        break;
      case "escape": case "html":
        fragment.append(document.createTextNode(token.text));
        break;
      case "paragraph": case "blockquote": case "strong": case "em": case "del": case "heading": case "list_item": {
        const tag = { paragraph: "p", heading: `h${token.depth}`, list_item: "li" }[token.type] || token.type;
        fragment.append(element(tag, renderTokens(token.tokens)));
        break;
      }
      case "code":
        fragment.append(codeBlock(token.text));
        break;
      case "codespan":
        fragment.append(element("code", document.createTextNode(token.text)));
        break;
      case "br": case "hr":
        fragment.append(element(token.type));
        break;
      case "link": {
        const content = renderTokens(token.tokens);
        const href = linkTarget(token.href);
        if (!href) { fragment.append(content); break; }
        const link = element("a", content);
        link.href = href;
        link.rel = "noopener noreferrer";
        if (token.title) link.title = decodeEntities(token.title);
        fragment.append(link);
        break;
      }
      case "image":
        // Keep attachments inert, including external image URLs.
        fragment.append(document.createTextNode(`[Image: ${decodeEntities(token.text)}]`));
        break;
      case "list": {
        const list = element(token.ordered ? "ol" : "ul", renderTokens(token.items));
        if (token.ordered) list.start = token.start;
        fragment.append(list);
        break;
      }
      case "checkbox": {
        const checkbox = element("input");
        checkbox.type = "checkbox";
        checkbox.disabled = true;
        checkbox.checked = token.checked;
        checkbox.setAttribute("aria-label", token.checked ? "Completed" : "Incomplete");
        fragment.append(checkbox);
        break;
      }
      case "table": {
        const row = (cells, tag) => {
          const tr = element("tr");
          cells.forEach((cell, index) => {
            const td = element(tag, renderTokens(cell.tokens));
            if (token.align[index]) td.dataset.align = token.align[index];
            tr.append(td);
          });
          return tr;
        };
        const table = element("table", element("thead", row(token.header, "th")));
        const body = element("tbody");
        for (const cells of token.rows) body.append(row(cells, "td"));
        table.append(body);
        const wrapper = element("div", table);
        wrapper.className = "markdown-table";
        fragment.append(wrapper);
        break;
      }
      default:
        fragment.append(document.createTextNode(token.raw || token.text || ""));
    }
  }
  return fragment;
}
export function renderMarkdown(source) {
  const node = element("div", renderTokens(lexer(source ?? "", { gfm: true, breaks: true })));
  node.className = "message-text markdown";
  return node;
}
