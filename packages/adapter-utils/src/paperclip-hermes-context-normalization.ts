function normalizedString(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function stablePaperclipHermesContextValue(value: unknown): unknown {
  if (typeof value === "string") return normalizedString(value);
  if (Array.isArray(value)) return value.map(stablePaperclipHermesContextValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stablePaperclipHermesContextValue(item)]),
    );
  }
  return value;
}

export function paperclipHermesContextValueFingerprint(value: unknown): string {
  return JSON.stringify(stablePaperclipHermesContextValue(value));
}
