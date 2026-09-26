export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates = [trimmed, ...fences.map((m) => m[1].trim())];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as T; } catch { /* keep trying */ }
    const firstObject = candidate.indexOf("{");
    const lastObject = candidate.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try { return JSON.parse(candidate.slice(firstObject, lastObject + 1)) as T; } catch { /* ignore */ }
    }
    const firstArray = candidate.indexOf("[");
    const lastArray = candidate.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) {
      try { return JSON.parse(candidate.slice(firstArray, lastArray + 1)) as T; } catch { /* ignore */ }
    }
  }
  throw new Error("Agent did not return valid JSON");
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
}

export function shortText(text: string, maxChars = 4000): string {
  const normalized = text.replace(/\r/g, "").trim();
  if (normalized.length <= maxChars) return normalized;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${normalized.slice(0, head)}\n\n[... ${normalized.length - maxChars} chars archived ...]\n\n${normalized.slice(-tail)}`;
}
