import type { PaperContentSourceMode } from "../../shared/types";

export type TextAttachmentSourceMode = Extract<
  PaperContentSourceMode,
  "markdown" | "html" | "txt" | "docx"
>;

export type SupportedContextAttachmentType = "pdf" | TextAttachmentSourceMode;
export type ContextAttachmentReadableVia = "paper_read" | "read_attachment";

export type ContextAttachmentSupport =
  | {
      kind: "pdf";
      attachmentType: "pdf";
      readableVia: "paper_read";
    }
  | {
      kind: "text";
      attachmentType: TextAttachmentSourceMode;
      contentSourceMode: TextAttachmentSourceMode;
      readableVia: "read_attachment";
    };
