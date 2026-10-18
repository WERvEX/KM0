/** Pull a JSON value out of model text that may be wrapped in a code fence or prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // Fall through to the outermost object or array in the text.
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = body.indexOf(open);
    const end = body.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        // Try the next shape.
      }
    }
  }
  throw new SyntaxError("No JSON value found in the model output");
}
