// Lightweight PDF page-tree scanning; compressed object streams may yield no count.
function decodeLatin1(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    parts.push(String.fromCharCode(...chunk));
  }
  return parts.join("");
}

export function extractPdfPageCountFromText(text: string): number | null {
  if (!text) return null;
  const counts: number[] = [];
  const typePagesRegex = /\/Type\s*\/Pages\b/g;
  let match: RegExpExecArray | null;
  while ((match = typePagesRegex.exec(text))) {
    const start = Math.max(0, match.index - 2500);
    const end = Math.min(text.length, match.index + 2500);
    const windowText = text.slice(start, end);
    const countRegex = /\/Count\s+(\d{1,7})\b/g;
    let countMatch: RegExpExecArray | null;
    while ((countMatch = countRegex.exec(windowText))) {
      const count = Number(countMatch[1]);
      if (Number.isFinite(count) && count > 0) counts.push(Math.floor(count));
    }
  }
  return counts.length ? Math.max(...counts) : null;
}

export function extractPdfPageCountFromBytes(bytes: Uint8Array): number | null {
  if (!bytes.length) return null;
  return extractPdfPageCountFromText(decodeLatin1(bytes));
}
