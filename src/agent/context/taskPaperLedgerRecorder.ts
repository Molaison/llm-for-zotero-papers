/**
 * The host's one recorder for the Task progress ledger.
 *
 * `attestAndRecordRead` is the only way the tool-execution paths attest a
 * read: it issues the trusted read observations and derives the paper ledger
 * delta from the same call, so nothing can attest a read without recording
 * it. (The plan session re-attests a call the tool-execution path already
 * attested and recorded, to file plan evidence; it deliberately does not
 * record a second time.)
 */
import { createTrustedReadObservations } from "../plans/readObservation";
import type { TrustedReadObservation } from "../plans/types";
import type { ZoteroMcpToolActivityEvent } from "../mcp/activityTypes";
import type { AgentEvent } from "../types";
import {
  deriveTaskPaperLedgerDelta,
  type TaskPaperLedgerDelta,
  type TaskPaperResolvedRef,
} from "./taskPaperLedger";

export type PaperLedgerUpdateEvent = Extract<
  AgentEvent,
  { type: "paper_ledger_update" }
>;

type ZoteroItemLike = {
  id?: number;
  libraryID?: number;
  parentID?: number | false | null;
};

function zoteroItem(id: number | undefined): ZoteroItemLike | null {
  if (!id) return null;
  try {
    const items = (
      globalThis as {
        Zotero?: { Items?: { get?: (id: number) => unknown } };
      }
    ).Zotero?.Items;
    const item = items?.get?.(id);
    return item && typeof item === "object" ? (item as ZoteroItemLike) : null;
  } catch {
    return null;
  }
}

/** The bibliographic item and library a row's ids name, as Zotero knows them. */
export function resolveZoteroPaperRef(ref: {
  itemId?: number;
  contextItemId?: number;
}): TaskPaperResolvedRef | null {
  const direct = zoteroItem(ref.itemId);
  const start = direct || zoteroItem(ref.contextItemId);
  if (!start) return null;
  const startId = (direct ? ref.itemId : ref.contextItemId) || 0;
  // An attachment stands for its parent paper.
  const parentId = Number(start.parentID) || 0;
  const paper = parentId ? zoteroItem(parentId) : start;
  const itemId = parentId || startId;
  if (!itemId) return null;
  const libraryID = Number(paper?.libraryID ?? start.libraryID) || undefined;
  return libraryID ? { itemId, libraryID } : { itemId };
}

/**
 * The ledger delta of one successful read call, or `null` when there is no
 * conversation to record it in (an MCP client without a conversation) or
 * the call read no paper. Never throws: the ledger is bookkeeping and must
 * not fail the call it describes.
 */
export function recordTaskPaperRead(params: {
  toolName: string;
  callId: string;
  input: unknown;
  /** The tool's original content, never a handle-replaced copy. */
  content: unknown;
  conversationKey?: number;
  libraryID?: number;
  runId?: string;
}): TaskPaperLedgerDelta | null {
  if (!params.conversationKey || params.conversationKey <= 0) return null;
  try {
    return deriveTaskPaperLedgerDelta({
      toolName: params.toolName,
      callId: params.callId,
      input: params.input,
      content: params.content,
      libraryID: params.libraryID,
      runId: params.runId,
      resolvePaper: resolveZoteroPaperRef,
    });
  } catch {
    return null;
  }
}

/** Attest a successful read and record it in the task ledger, together. */
export async function attestAndRecordRead(params: {
  toolName: string;
  callId: string;
  input: unknown;
  result: unknown;
  conversationKey?: number;
  libraryID?: number;
  runId?: string;
}): Promise<{
  observations: TrustedReadObservation[];
  paperLedgerDelta: TaskPaperLedgerDelta | null;
}> {
  const observations = await createTrustedReadObservations({
    toolName: params.toolName,
    callId: params.callId,
    input: params.input,
    result: params.result,
  });
  const paperLedgerDelta = recordTaskPaperRead({
    toolName: params.toolName,
    callId: params.callId,
    input: params.input,
    content: params.result,
    conversationKey: params.conversationKey,
    libraryID: params.libraryID,
    runId: params.runId,
  });
  return { observations, paperLedgerDelta };
}

export function buildPaperLedgerUpdateEvent(
  delta: TaskPaperLedgerDelta,
): PaperLedgerUpdateEvent {
  return { type: "paper_ledger_update", callId: delta.callId, delta };
}

/**
 * The run event a connected runtime's MCP activity carries, if any: only a
 * successful completion with a delta produces one.
 */
export function paperLedgerUpdateFromMcpActivity(
  event: Pick<ZoteroMcpToolActivityEvent, "phase" | "ok" | "paperLedgerDelta">,
): PaperLedgerUpdateEvent | null {
  if (event.phase !== "completed" || !event.ok || !event.paperLedgerDelta) {
    return null;
  }
  return buildPaperLedgerUpdateEvent(event.paperLedgerDelta);
}
