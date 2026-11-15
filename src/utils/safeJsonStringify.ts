/**
 * JSON.stringify is allowed to emit U+2028 and U+2029 literally. Those code
 * points are legal JavaScript string content, but they are also line
 * separators. Escape them when embedding JSON values in line-oriented model
 * context so one resource cannot manufacture another resource row.
 */
export function safeJsonStringify(value: unknown): string | undefined {
  const serialized = JSON.stringify(value);
  return serialized
    ?.replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
