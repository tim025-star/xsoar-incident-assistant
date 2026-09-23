export type SanitizerValueMode = "placeholder" | "empty";

/** Flatten JSON into dotted paths while replacing every source value. */
export function sanitizeJson(input: unknown, mode: SanitizerValueMode = "placeholder"): Record<string, string> {
  const output = Object.create(null) as Record<string, string>;
  const replacement = mode === "empty" ? "" : "[REDACTED]";

  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      if (value.length === 0 && path) output[path] = replacement;
      for (const item of value) visit(item, path);
      return;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0 && path) output[path] = replacement;
      for (const [key, child] of entries) {
        const segment = key.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
        visit(child, path ? `${path}.${segment}` : segment);
      }
      return;
    }
    output[path || "$"] = replacement;
  };

  visit(input, "");
  return output;
}
