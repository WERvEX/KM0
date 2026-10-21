/** Pull a JSON value out of model text that may be wrapped in a code fence or prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const candidates = [body];
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    // Fall back to the outermost object or array in the text.
    const start = body.indexOf(open);
    const end = body.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(body.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    for (const attempt of [candidate, escapeStrayQuotes(candidate)]) {
      try {
        return JSON.parse(attempt);
      } catch {
        // Try the next shape.
      }
    }
  }
  throw new SyntaxError("No JSON value found in the model output");
}

/**
 * Escape double quotes that sit inside a string value. Some relays turn quotation marks like “ ” into plain `"`,
 * which ends the string early; a quote counts as closing only when the next non-space character could follow a
 * string in JSON.
 */
export function escapeStrayQuotes(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (char === "\\") {
      out += char + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === '"') {
      const next = /\S/.exec(text.slice(i + 1))?.[0];
      if (next === undefined || next === "," || next === ":" || next === "}" || next === "]") {
        inString = false;
        out += char;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += char;
  }
  return out;
}
