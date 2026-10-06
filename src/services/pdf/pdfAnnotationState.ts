import type { ResolvedPdfHighlight } from "./pdfAnnotationResolver";

export type PdfHighlightPayload = ResolvedPdfHighlight & {
  color: string;
  comment: string;
};

/** Read native fields, never a tool's success flag or a truncated library summary. */
export function annotationMatchesPayload(
  item: any,
  attachmentId: number,
  expected: PdfHighlightPayload,
): boolean {
  try {
    const position =
      typeof item?.annotationPosition === "string"
        ? JSON.parse(item.annotationPosition)
        : item?.annotationPosition;
    return Boolean(
      item?.isAnnotation?.() &&
      !item.deleted &&
      Number(item.parentID) === attachmentId &&
      item.annotationType === "highlight" &&
      item.annotationText === expected.text &&
      (item.annotationComment || "") === expected.comment &&
      item.annotationColor === expected.color &&
      item.annotationPageLabel === expected.pageLabel &&
      item.annotationSortIndex === expected.sortIndex &&
      position?.pageIndex === expected.position.pageIndex &&
      JSON.stringify(position?.rects) ===
        JSON.stringify(expected.position.rects) &&
      !position?.nextPageRects,
    );
  } catch {
    return false;
  }
}
