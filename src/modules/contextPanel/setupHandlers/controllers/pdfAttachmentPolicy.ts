export function getZoteroAttachmentFilename(item: unknown): string {
  const attachment = item as {
    attachmentFilename?: unknown;
    getFilename?: () => unknown;
    getField?: (field: string) => unknown;
  };
  const candidates = [
    attachment?.attachmentFilename,
    typeof attachment?.getFilename === "function"
      ? attachment.getFilename()
      : undefined,
    typeof attachment?.getField === "function"
      ? attachment.getField("filename")
      : undefined,
  ];
  return String(
    candidates.find((value) => typeof value === "string") || "",
  ).trim();
}

/** Metadata prefilter only; every transport still verifies the %PDF signature. */
export function isZoteroPdfAttachmentCandidate(item: unknown): boolean {
  const attachment = item as {
    isAttachment?: () => boolean;
    attachmentContentType?: unknown;
  };
  if (!attachment?.isAttachment?.()) return false;
  const contentType = String(attachment.attachmentContentType || "")
    .trim()
    .toLowerCase();
  return (
    contentType === "application/pdf" ||
    getZoteroAttachmentFilename(attachment).toLowerCase().endsWith(".pdf")
  );
}
