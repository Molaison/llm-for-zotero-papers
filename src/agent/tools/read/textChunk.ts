import { sliceTextToTokenBudget } from "../../../utils/modelInputCap";

/** Lossless character cursor; callers reserve tokens for their response envelope. */
export function readTextChunk(text: string, offset: number, maxTokens: number) {
  const textOffset = Math.min(Math.max(0, Math.floor(offset)), text.length);
  const chunk = sliceTextToTokenBudget(
    text.slice(textOffset),
    Math.max(1, maxTokens),
  );
  const next = textOffset + chunk.length;
  return {
    text: chunk,
    textOffset,
    totalChars: text.length,
    ...(next < text.length ? { nextTextOffset: next } : {}),
  };
}
