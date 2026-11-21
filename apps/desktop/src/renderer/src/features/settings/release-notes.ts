/** Matches real HTML tags (so Markdown containing placeholders like `` `km0/<run_id>/final` `` stays untouched). */
const HTML_TAG =
  /<\/?(p|div|h[1-6]|ul|ol|li|blockquote|pre|code|table|thead|tbody|tr|th|td|strong|em|b|i|del|s|a|br|hr)\b[^>]*>/i;

const IGNORED_TAGS = new Set(["script", "style", "noscript", "iframe", "object", "embed", "svg"]);

function wrapInline(text: string, marker: string): string {
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!match?.[2]) return text;
  return `${match[1] ?? ""}${marker}${match[2]}${marker}${match[3] ?? ""}`;
}

function inlineCode(raw: string): string {
  if (!raw) return "";
  const runs = [...raw.matchAll(/`+/g)].map((m) => m[0].length);
  const fence = "`".repeat((runs.length > 0 ? Math.max(...runs) : 0) + 1);
  const padded = raw.startsWith("`") || raw.endsWith("`") ? ` ${raw} ` : raw;
  return `${fence}${padded}${fence}`;
}

function codeBlock(el: Element): string {
  const inner = el.querySelector("code") ?? el;
  const raw = (inner.textContent ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const langMatch = inner.className.match(/(?:^|\s)(?:language|lang)-([\w+-]+)/i);
  const lang = langMatch?.[1] ?? "";
  const runs = [...raw.matchAll(/`+/g)].map((m) => m[0].length);
  const fence = "`".repeat(Math.max(3, (runs.length > 0 ? Math.max(...runs) : 0) + 1));
  return `${fence}${lang}\n${raw}\n${fence}\n\n`;
}

function tableMarkdown(el: Element, convertInline: (nodes: Node[]) => string): string {
  const rows = [...el.querySelectorAll("tr")].filter((tr) => tr.closest("table") === el);
  if (rows.length === 0) return "";
  const readCells = (row: Element) =>
    [...row.children]
      .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
      .map((cell) =>
        convertInline([...cell.childNodes])
          .replace(/\r?\n+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .replaceAll("|", "\\|"),
      );
  const header = readCells(rows[0] as Element);
  if (header.length === 0) return "";
  const pad = (cells: string[]) => header.map((_, i) => cells[i] ?? "");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${pad(readCells(row)).join(" | ")} |`),
  ];
  return `${lines.join("\n")}\n\n`;
}

function childrenText(el: Element, depth: number): string {
  return nodesToMarkdown([...el.childNodes], depth);
}

function listMarkdown(el: Element, ordered: boolean, depth: number): string {
  const items = [...el.children].filter((child) => child.tagName.toLowerCase() === "li");
  if (items.length === 0) return "";
  const start = ordered ? Number.parseInt(el.getAttribute("start") ?? "1", 10) || 1 : 1;
  const indent = "  ".repeat(depth);
  const lines: string[] = [];

  items.forEach((item, index) => {
    const bullet = ordered ? `${start + index}. ` : "- ";
    const mainNodes: Node[] = [];
    const nestedLists: Element[] = [];
    for (const child of item.childNodes) {
      if (child.nodeType === 1) {
        const tag = (child as Element).tagName.toLowerCase();
        if (tag === "ul" || tag === "ol") {
          nestedLists.push(child as Element);
          continue;
        }
      }
      mainNodes.push(child);
    }
    const body = nodesToMarkdown(mainNodes, depth + 1)
      .replace(/\n{2,}/g, "\n")
      .trim();
    const formattedBody = body
      .split("\n")
      .map((line, i) => (i === 0 ? line : `${indent}  ${line}`))
      .join("\n");
    lines.push(`${indent}${bullet}${formattedBody}`);
    for (const nested of nestedLists) {
      const nestedText = listMarkdown(nested, nested.tagName.toLowerCase() === "ol", depth + 1).replace(/\n+$/, "");
      if (nestedText) lines.push(nestedText);
    }
  });

  return `${lines.join("\n")}${depth === 0 ? "\n\n" : "\n"}`;
}

function nodesToMarkdown(nodes: Node[], depth: number): string {
  let out = "";
  for (const node of nodes) {
    if (node.nodeType === 3) {
      out += (node.textContent ?? "").replace(/\s+/g, " ");
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (IGNORED_TAGS.has(tag)) continue;

    if (tag === "br") {
      out += "  \n";
    } else if (tag === "hr") {
      out += "\n---\n\n";
    } else if (tag === "strong" || tag === "b") {
      out += wrapInline(childrenText(el, depth), "**");
    } else if (tag === "em" || tag === "i") {
      out += wrapInline(childrenText(el, depth), "*");
    } else if (tag === "del" || tag === "s") {
      out += wrapInline(childrenText(el, depth), "~~");
    } else if (tag === "code") {
      out += inlineCode(el.textContent ?? "");
    } else if (tag === "pre") {
      out += codeBlock(el);
    } else if (tag === "a") {
      const label = childrenText(el, depth).trim() || (el.getAttribute("href") ?? "").trim();
      const href = (el.getAttribute("href") ?? "").trim();
      out += /^https?:\/\//i.test(href) ? `[${label}](${href})` : label;
    } else if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const heading = childrenText(el, depth).trim();
      if (heading) out += `\n${"#".repeat(level)} ${heading}\n\n`;
    } else if (tag === "p" || tag === "div") {
      const body = childrenText(el, depth).trim();
      if (body) out += `${body}\n\n`;
    } else if (tag === "blockquote") {
      const inner = childrenText(el, depth).trim();
      if (inner) {
        const quoted = inner
          .split("\n")
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n");
        out += `${quoted}\n\n`;
      }
    } else if (tag === "ul" || tag === "ol") {
      out += listMarkdown(el, tag === "ol", depth);
    } else if (tag === "table") {
      out += tableMarkdown(el, (cellNodes) => nodesToMarkdown(cellNodes, depth));
    } else {
      out += childrenText(el, depth);
    }
  }
  return out;
}

/**
 * Normalize release notes from electron-updater into safe GFM Markdown. GitHub Releases delivers pre-rendered HTML
 * (`<ul>`, `<li>`, `<blockquote>`, `<code>`, `<table>`), whereas plain feeds / test fixtures supply Markdown.
 */
export function normalizeReleaseNotes(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !HTML_TAG.test(trimmed)) return trimmed;
  const doc = new DOMParser().parseFromString(trimmed, "text/html");
  return nodesToMarkdown([...doc.body.childNodes], 0)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
