export type AttachmentFileState = {
  path: string;
  size: number | null;
  mtime: number | null;
};

type StatCapable = { getFilePathAsync?: () => Promise<string | false> };

/**
 * One stat per attachment, shared by the research scope snapshot and the
 * library text index reconcile. Null means "no local file": linked files that
 * were never downloaded, remote-only group attachments, or a stat failure.
 */
export async function readAttachmentFileState(
  item: Zotero.Item | null | undefined,
): Promise<AttachmentFileState | null> {
  try {
    const path = await (
      item as StatCapable | null | undefined
    )?.getFilePathAsync?.();
    if (!path) return null;
    const io = (
      globalThis as unknown as {
        IOUtils?: {
          stat?: (
            p: string,
          ) => Promise<{ size?: unknown; lastModified?: unknown }>;
        };
      }
    ).IOUtils;
    const stat = await io?.stat?.(path);
    if (!stat) return null;
    const size = Number(stat.size);
    const mtime = Number(stat.lastModified);
    return {
      path,
      size: Number.isFinite(size) ? size : null,
      mtime: Number.isFinite(mtime) ? mtime : null,
    };
  } catch {
    return null;
  }
}
