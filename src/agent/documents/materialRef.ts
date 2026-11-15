/**
 * Identity of one finalized material revision.
 *
 * It lives in its own leaf module because every layer that names material —
 * documents, the action contract, the runtime, checkpoints — must use this one
 * identity, and none of them may depend on the rest of the document types to
 * do so.
 */
export type MaterialRef = Readonly<{
  documentId: string;
  documentVersion: number;
  contentHash: string;
}>;

/**
 * Read a complete reference out of a record that carries the three identity
 * fields flat, as frozen action parameters and tool arguments do.
 *
 * Only a complete ref identifies one revision, so a partially frozen source
 * names nothing rather than half a ref.
 */
export function readFlatMaterialRef(
  source:
    | {
        documentId?: string;
        documentVersion?: number;
        contentHash?: string;
      }
    | undefined,
): MaterialRef | undefined {
  const { documentId, documentVersion, contentHash } = source || {};
  if (!documentId || !contentHash) return undefined;
  if (typeof documentVersion !== "number") return undefined;
  if (!Number.isSafeInteger(documentVersion) || documentVersion < 1)
    return undefined;
  return { documentId, documentVersion, contentHash };
}
