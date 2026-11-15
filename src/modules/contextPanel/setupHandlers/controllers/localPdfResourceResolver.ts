import type {
  LocalDocumentResource,
  PaperContextRef,
} from "../../../../shared/types";
import { isAbsoluteLocalPath } from "../../../../utils/localPath";
import {
  getZoteroAttachmentFilename,
  isZoteroPdfAttachmentCandidate,
} from "./pdfAttachmentPolicy";

type LocalPdfFileInspection = {
  size: number;
  type: string;
  header: Uint8Array;
};

type LocalPdfResourceResolverDeps = {
  getItemById?: (itemId: number) => Zotero.Item | null;
  inspectFile?: (path: string) => Promise<LocalPdfFileInspection>;
};

export function createLocalPdfResourceResolver(
  deps: LocalPdfResourceResolverDeps = {},
): {
  resolve: (
    paperContexts: PaperContextRef[],
  ) => Promise<readonly LocalDocumentResource[]>;
} {
  const getItemById =
    deps.getItemById || ((itemId) => Zotero.Items.get(itemId) || null);
  const inspectFile =
    deps.inspectFile ||
    (async (path: string) => {
      const info = await IOUtils.stat(path);
      const header = await IOUtils.read(path, { maxBytes: 5 });
      return {
        size: Number(info.size) || 0,
        type: String(info.type || ""),
        header,
      };
    });

  return {
    resolve: async (paperContexts) => {
      const resources: LocalDocumentResource[] = [];
      for (const paperContext of paperContexts) {
        if (paperContext.contentSourceMode !== "pdf") {
          throw new Error(
            "Only an explicitly selected PDF source can become a raw PDF resource.",
          );
        }
        const attachment = getItemById(paperContext.contextItemId);
        if (!attachment?.isAttachment?.()) {
          throw new Error("Selected PDF attachment no longer exists.");
        }
        if ((attachment as unknown as { deleted?: unknown }).deleted) {
          throw new Error("Selected PDF attachment is in the Zotero trash.");
        }
        const parentId =
          Number((attachment as unknown as { parentID?: number }).parentID) ||
          0;
        if (parentId) {
          const parent = getItemById(paperContext.itemId);
          if (parentId !== paperContext.itemId || !parent?.isRegularItem?.()) {
            throw new Error(
              "Selected PDF attachment no longer belongs to this paper.",
            );
          }
          if ((parent as unknown as { deleted?: unknown }).deleted) {
            throw new Error(
              "Selected PDF parent paper is in the Zotero trash.",
            );
          }
        } else if (paperContext.itemId !== paperContext.contextItemId) {
          throw new Error(
            "Standalone PDF identity does not match its attachment.",
          );
        }
        const attachmentFilename = getZoteroAttachmentFilename(attachment);
        if (!isZoteroPdfAttachmentCandidate(attachment)) {
          throw new Error("Selected attachment is not a PDF.");
        }
        let asyncPath: string | false | undefined;
        let fallbackPath: string | undefined;
        try {
          asyncPath = await (
            attachment as unknown as {
              getFilePathAsync?: () => Promise<string | false>;
            }
          ).getFilePathAsync?.();
          if (!(typeof asyncPath === "string" && asyncPath)) {
            fallbackPath =
              typeof (
                attachment as {
                  getFilePath?: () => string | undefined;
                }
              ).getFilePath === "function"
                ? (
                    attachment as {
                      getFilePath: () => string | undefined;
                    }
                  ).getFilePath()
                : (attachment as unknown as { attachmentPath?: string })
                    .attachmentPath;
          }
        } catch {
          throw new Error("Selected PDF file is missing or unreadable.");
        }
        const absolutePath =
          typeof asyncPath === "string" && asyncPath
            ? asyncPath
            : typeof fallbackPath === "string"
              ? fallbackPath
              : "";
        if (!isAbsoluteLocalPath(absolutePath)) {
          throw new Error("Selected PDF does not have an absolute local path.");
        }
        let inspection: LocalPdfFileInspection;
        try {
          inspection = await inspectFile(absolutePath);
        } catch {
          throw new Error("Selected PDF file is missing or unreadable.");
        }
        if (inspection.type !== "regular" || inspection.size <= 0) {
          throw new Error("Selected PDF file is missing or unreadable.");
        }
        if (
          inspection.header.length < 5 ||
          String.fromCharCode(...inspection.header.slice(0, 5)) !== "%PDF-"
        ) {
          throw new Error("Selected file is not a valid PDF.");
        }
        const sourceKey =
          `zotero-pdf:${paperContext.itemId}:${paperContext.contextItemId}` as const;
        if (resources.some((resource) => resource.sourceKey === sourceKey)) {
          throw new Error("The same PDF was selected more than once.");
        }
        resources.push(
          Object.freeze({
            kind: "local_pdf",
            sourceKey,
            itemId: paperContext.itemId,
            contextItemId: paperContext.contextItemId,
            title: paperContext.title,
            name:
              attachmentFilename ||
              absolutePath.split(/[\\/]/).pop() ||
              "document.pdf",
            mimeType: "application/pdf",
            absolutePath,
          }),
        );
      }
      return Object.freeze(resources);
    },
  };
}
