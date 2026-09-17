/**
 * Safe parsing of model-supplied tool arguments. Providers sometimes stream
 * malformed JSON (truncated, wrapped in prose, double-encoded). This helper
 * never throws: valid JSON wins, otherwise a JSON object is extracted from the
 * string, otherwise `{}` is returned — same contract everywhere tool args are
 * deserialized (execution AND provider-side re-mapping).
 */

export function parseToolArguments(raw: string): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(raw || "{}");
    if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
  } catch {
    const extracted = extractJson(raw);
    if (extracted !== null) args = extracted;
  }
  return args;
}

function extractJson(raw: string): Record<string, unknown> | null {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(raw.slice(first, last + 1));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}