/**
 * What a conversation still owes a note batch, said in the prompt.
 *
 * A batch that stopped halfway leaves its unwritten notes in durable rows,
 * but the model cannot see a table. Without a host block naming the batch,
 * the only way it knew to continue was to author every body again -- which is
 * exactly the cost the per-item rows exist to avoid. The block names the
 * batch and the one call that continues it; the rows themselves stay the
 * authority on which items are still outstanding.
 *
 * The counts are read from the rows, so a note that was saved and then
 * deleted in Zotero still counts as `saved` here. The resume path is where
 * native existence is re-checked, because that is the moment the answer can
 * still change what gets written.
 */
import type { ResumableBatch } from "../store/batchItemStore";

/**
 * The host block that names batches the conversation can continue.
 * Empty when nothing is outstanding.
 */
export function formatResumableBatchRecoveryLines(
  batches: readonly ResumableBatch[],
): string[] {
  if (!batches.length) return [];
  return [
    "Resumable note batches:",
    ...batches.flatMap((batch) => [
      `batchId=${batch.batchId} total=${batch.total} saved=${batch.saved} failed=${batch.failed} pending=${batch.pending}`,
      `To continue, call note_write_batch with resumeBatchId=${batch.batchId}; the saved items are skipped and no note is regenerated.`,
    ]),
  ];
}
