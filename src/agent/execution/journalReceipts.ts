/**
 * Receipts for the notes a run created, read back from the change journal.
 *
 * A receipt reaches the outcome ledger with its call's result. A run that
 * ends while a write is still running, or a Zotero that quits mid-batch,
 * can lose that result, but never the journal: every note creation is a
 * durable step of its own (`services/noteCreation.ts`), whose forward record
 * names the paper the note was written on and whose result names the note.
 * These receipts let a resumed ledger take what the run wrote
 * (`reconcileJournaledReceipts` in `loop/outcomes.ts`).
 *
 * Only note creations are read. They are the writes a repeat would make
 * twice, which is what a ledger that lost their receipts invites; setting a
 * tag, a folder or a field again changes nothing.
 */
import { listJournalActions } from "../store/changeJournal";
import type { AgentActionReceipt } from "../types";

/** Step states in which the step's own write landed. */
const LANDED_STEP_STATUSES: ReadonlySet<string> = new Set([
  "applied",
  "partially_applied",
  "irreversible",
]);

/** More journal actions than one run writes. */
const RUN_ACTION_LIMIT = 1000;

function parsed(json: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(json || "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function positiveInt(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/**
 * One receipt for each note `runId` created on a paper in this conversation
 * and that is still a live note on that paper, in the order they were
 * written. A receipt is named after its journal step, so applying the same
 * journal twice binds nothing new. A note that is gone, trashed or moved
 * proves nothing now, and a standalone note names no paper; neither has one.
 */
export async function journaledNoteReceipts(params: {
  runId: string;
  conversationKey: number;
  /** Live Zotero state; defaults to `Zotero.Items.get`. */
  getItem?: (itemId: number) => Zotero.Item | null;
}): Promise<AgentActionReceipt[]> {
  const getItem =
    params.getItem ||
    ((itemId: number) => Zotero.Items.get(itemId) as Zotero.Item | null);
  const actions = await listJournalActions({
    runId: params.runId,
    conversationKey: params.conversationKey,
    limit: RUN_ACTION_LIMIT,
  });
  const steps = actions
    .flatMap((action) =>
      action.steps.map((step) => ({ step, createdAt: action.createdAt })),
    )
    .filter(
      ({ step }) =>
        step.operation === "create_note" &&
        LANDED_STEP_STATUSES.has(step.status),
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.step.createdAt - right.step.createdAt ||
        left.step.sequence - right.step.sequence,
    );
  const receipts: AgentActionReceipt[] = [];
  for (const { step } of steps) {
    const forward = parsed(step.forwardJson);
    const result = parsed(step.resultJson);
    const paperId = positiveInt(forward.parentItemId);
    const noteId = positiveInt(result.noteId);
    if (!paperId || !noteId || result.status !== "created") continue;
    let note: Zotero.Item | null = null;
    try {
      note = getItem(noteId);
    } catch {
      note = null;
    }
    if (
      !note ||
      note.isNote?.() !== true ||
      Boolean((note as { deleted?: unknown }).deleted) ||
      Number(note.parentID) !== paperId
    )
      continue;
    const paper = `item:${paperId}`;
    receipts.push({
      version: 2,
      id: `journal:${step.stepId}`,
      proposalId: `journal:${step.stepId}`,
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      operation: "note_create",
      verification: "verified",
      status: "applied",
      requestedTargets: [paper],
      appliedTargets: [paper],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [`created_note:item:${noteId}`],
      evidenceRef: step.stepId,
    });
  }
  return receipts;
}
