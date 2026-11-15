import type { AgentEvent } from "./types";

/**
 * What one agent flight cost, read off the run's own event stream.
 *
 * A pure function over an `AgentEvent[]`, with the two quantities that leave
 * no event behind passed in as extras. It exists so a scripted journey in the
 * unit suite can be measured the same way twice and the numbers pinned
 * against drift.
 *
 * Every count comes from a declared contract -- the `stage` a call announced,
 * the `written` flag a durable batch row carries, the facts a receipt proved.
 * None comes from a tool's name: tools are renamed for presentation, so a
 * number keyed on a name would move for a reason that is not a behavior
 * change.
 */
export type AgentFlightSummary = {
  /** Generation steps per turn, in turn order (the adapter seam's count). */
  modelCallsPerTurn: number[];
  modelCallsTotal: number;
  /**
   * What one durable-batch item cost in model calls, rounded to two decimals;
   * `null` when the flight ran no batch.
   *
   * The numerator is only the model calls of the turns that carried batch work
   * -- the turns whose events announced at least one `batch_item_outcome` --
   * divided by the distinct items those turns touched. A turn that did
   * something else (the undo turn at the end of the batch journey, a question
   * the user asked in between) is not the batch's cost and must not move this
   * number.
   *
   * Turns come from `extras.turnEvents`. A caller that cannot split its
   * events by turn charges the batch for every model call of the flight, which
   * is the old whole-flight reading and an over-estimate.
   *
   * This is the number the per-item batch contract exists to hold down: a
   * batch of fifty notes must not cost fifty model calls.
   */
  modelCallsPerBatchItem: number | null;
  /**
   * Tool calls grouped by the product stage each call declared.
   *
   * Keys are `AgentStage` values, plus `"unattributed"` for a call that
   * declared no category at all (an older trace, or a tool with no contract).
   */
  toolCallsByStage: Record<string, number>;
  /**
   * Distinct notes proved written by receipt FACTS, by note id.
   *
   * Read from `verifiedFacts`: `created_note:item:<id>` and
   * `native_note:<id>:...`, the facts the note-write verifier mints after a
   * forced native content read-back.
   *
   * A receipt that was verified only against captured post-state counts zero
   * here even though it is `verification: "verified"`, because it names no
   * note and proves no content. Zero therefore means "no content read-back was
   * recorded", never "the writes were unverified".
   *
   * The durable note batch is counted here like any other write: it takes the
   * library-mutation receipt branch, whose whole-set post-state proves the
   * set, and beside that its receipt names each note the call physically
   * created with the read-back that creation forced. It is a per-note count,
   * so a resume proves only the row it wrote and the rows it skipped keep the
   * proof their own call recorded.
   */
  nativeWrites: number;
  /** Physical native writes observed at the store (passed in as an extra). */
  nativeSaves: number;
  /**
   * Physical writes the flight's receipts do not account for
   * (`nativeSaves - nativeWrites`, floored at zero).
   *
   * A second write of the same note raises it -- and so does a write whose
   * receipt carries no note fact, which is why it must be read together with
   * `batchItems.written` before anyone calls it a duplicate. Every write path
   * mints per-note facts today, the durable note batch included, so a number
   * above zero is a finding rather than a known gap.
   */
  duplicateNativeWrites: number;
  /**
   * Durable-batch rows as they were announced, one count per `written` case.
   *
   * A resumed batch announces every row it holds, so a row it did not write
   * this time is `announcedNotWritten` rather than a write.
   */
  batchItems: {
    written: number;
    announcedNotWritten: number;
    failed: number;
  };
  /** Material finalizations: the host-announced `material_finalized` events. */
  materialFinalized: number;
  /** What the flight spent on retrieval, and how much of it repeated. */
  retrieval: RetrievalFlightSummary;
};

/**
 * What a flight spent on retrieval, and how much of it was a repeat.
 *
 * The three counts answer different questions on purpose. `toolCalls` is what
 * the model asked for; `candidateBuilds` is what actually reached the ranking
 * pass, so the gap between them is the evidence cache doing its job;
 * `paperContextEnsures` is how often a paper's indexed text was asked for,
 * which is a separate cost and can move on its own.
 */
export type RetrievalFlightSummary = {
  /**
   * Tool calls that declared the retrieval stage.
   *
   * Read off the `agent_stage` the call announced (falling back to the
   * category the call itself declared), never off the tool's name -- this is
   * always equal to `toolCallsByStage.retrieval`.
   */
  toolCalls: number;
  /** Candidate-ranking passes the retrieval service actually ran (extra). */
  candidateBuilds: number;
  /** Times a paper's indexed context was ensured (extra). */
  paperContextEnsures: number;
  /**
   * Retrieval calls whose every named item had already been retrieved.
   *
   * A repeat here means the same ITEM, not the same question. Only a call
   * that repeats both the item and the query plan is served from the evidence
   * cache, which is keyed `contextItemId::<normalized query plan>`, so a
   * second call on the same paper asking something else is counted here and
   * still builds candidates. Read this number against `cacheHitRate` rather
   * than as a prediction of it.
   *
   * Items come from the identity fields a call's own arguments carry, so a
   * renamed tool moves nothing. A call that names no item is counted in
   * `toolCalls` but can never be shown to repeat one -- which makes this a
   * FLOOR, not a total: a tool that falls back to the conversation's papers
   * instead of naming them in its arguments retrieves an item this cannot
   * see, and a real flight therefore repeats at least this often and possibly
   * more.
   */
  repeatedCallsForSameItem: number;
  /**
   * The share of retrieval calls that built no candidates:
   * `1 - candidateBuilds / toolCalls`, rounded to two decimals, `null` when
   * the flight made no retrieval call.
   *
   * One call may retrieve several papers and build candidates for each, so
   * this can go below zero. That is a reading, not an error: it says the
   * flight built more rankings than it made calls.
   */
  cacheHitRate: number | null;
};

export type AgentFlightExtras = {
  /** One entry per turn, counted where the adapter was actually called. */
  modelCalls: readonly number[];
  /** Native writes that reached the store, counted at the save seam. */
  nativeSaves: number;
  /**
   * The same events, split by turn and in the same order as `modelCalls`.
   *
   * An `AgentEvent` does not say which turn it belongs to, so a cost that is
   * charged to some turns and not others needs the split from the caller. Omit
   * it and the whole flight is read as one turn.
   */
  turnEvents?: readonly (readonly AgentEvent[])[];
  /**
   * Retrieval work counted where it happens, inside the retrieval service.
   *
   * Neither a candidate build nor a paper-context ensure emits an event, so a
   * caller that wants them has to count them at the seams it injected
   * (`RetrievalService`'s `candidateBuilder` and the `PdfService` it was
   * built with). Omit them and both read zero, which makes every retrieval
   * call look like a cache miss.
   */
  retrievalCounters?: { candidateBuilds: number; paperContextEnsures: number };
};

/** The bucket a tool call with no declared work category is counted in. */
export const UNATTRIBUTED_STAGE = "unattributed";

/** The stage a call announces when it goes looking for evidence. */
const RETRIEVAL_STAGE = "retrieval";

/**
 * The argument fields a tool call names a Zotero item with.
 *
 * These are contract field names, published by the shared paper-target schema
 * and reused by every tool that takes a paper -- not tool names, which the
 * product renames freely. A call is attributed to an item only through them,
 * so a tool that invents its own spelling is counted as naming no item rather
 * than being guessed at.
 */
const ITEM_ID_ARG_FIELDS: ReadonlySet<string> = new Set([
  "itemId",
  "contextItemId",
  "targetItemId",
]);

/**
 * The item an identity field names, or nothing.
 *
 * Only a number or a non-blank string names an item. Everything else --
 * `null`, `undefined`, `""`, an empty array -- names none, and models do emit
 * those for optional identity fields. Coercing one would mint a synthetic
 * item `0` that every such call shares, and the second would then be reported
 * as a repeat of the first.
 */
function itemIdOfArgValue(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.floor(numeric)) : undefined;
}

/** Every item id a call's arguments name, however deeply they are nested. */
function itemIdsNamedByArgs(
  args: unknown,
  into = new Set<string>(),
): Set<string> {
  if (Array.isArray(args)) {
    for (const entry of args) itemIdsNamedByArgs(entry, into);
    return into;
  }
  if (!args || typeof args !== "object") return into;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (ITEM_ID_ARG_FIELDS.has(key)) {
      // An identity field is a leaf: whatever it holds, it is not a container
      // of further targets, so a value that names no item ends the descent.
      const itemId = itemIdOfArgValue(value);
      if (itemId) into.add(itemId);
      continue;
    }
    itemIdsNamedByArgs(value, into);
  }
  return into;
}

/**
 * What the flight's retrieval calls asked for, and how often they repeated.
 *
 * `calls` arrive in the order the flight made them, each with the item ids its
 * own arguments named. A call is a repeat when every item it names had already
 * been retrieved earlier in the flight -- the case the evidence cache exists
 * to make cheap.
 */
function summarizeRetrieval(
  calls: readonly (readonly string[])[],
  counters: AgentFlightExtras["retrievalCounters"],
): RetrievalFlightSummary {
  const seen = new Set<string>();
  let repeatedCallsForSameItem = 0;
  for (const itemIds of calls) {
    if (!itemIds.length) continue;
    if (itemIds.every((itemId) => seen.has(itemId)))
      repeatedCallsForSameItem += 1;
    else for (const itemId of itemIds) seen.add(itemId);
  }
  const candidateBuilds = counters?.candidateBuilds ?? 0;
  return {
    toolCalls: calls.length,
    candidateBuilds,
    paperContextEnsures: counters?.paperContextEnsures ?? 0,
    repeatedCallsForSameItem,
    cacheHitRate: calls.length
      ? roundHundredths(1 - candidateBuilds / calls.length)
      : null,
  };
}

const CREATED_NOTE_FACT = /^created_note:item:(\d+)$/;
const NATIVE_NOTE_FACT = /^native_note:(\d+):/;

function noteIdOfFact(fact: string): string | undefined {
  const created = CREATED_NOTE_FACT.exec(fact);
  if (created) return created[1];
  const native = NATIVE_NOTE_FACT.exec(fact);
  return native ? native[1] : undefined;
}

/** Every rate this module pins is rounded the same way, to two decimals. */
function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The model calls of the turns that carried batch work.
 *
 * Without a turn split there is nothing to narrow: the flight is read as one
 * turn, so every model call is charged to the batch.
 */
function batchTurnModelCalls(
  events: readonly AgentEvent[],
  extras: AgentFlightExtras,
  modelCallsTotal: number,
): number {
  const carriesBatchWork = (turn: readonly AgentEvent[]) =>
    turn.some((event) => event.type === "batch_item_outcome");
  if (!extras.turnEvents) return carriesBatchWork(events) ? modelCallsTotal : 0;
  let total = 0;
  extras.turnEvents.forEach((turn, index) => {
    if (carriesBatchWork(turn)) total += extras.modelCalls[index] ?? 0;
  });
  return total;
}

export function summarizeAgentFlight(
  events: readonly AgentEvent[],
  extras: AgentFlightExtras,
): AgentFlightSummary {
  const stageOfCall = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "agent_stage" || !event.callId) continue;
    if (!stageOfCall.has(event.callId))
      stageOfCall.set(event.callId, event.stage);
  }

  const toolCallsByStage: Record<string, number> = {};
  const writtenNoteIds = new Set<string>();
  const batchItemKeys = new Set<string>();
  const batchItems = { written: 0, announcedNotWritten: 0, failed: 0 };
  const retrievalCallItemIds: string[][] = [];
  let materialFinalized = 0;

  for (const event of events) {
    if (event.type === "tool_call") {
      const stage =
        stageOfCall.get(event.callId) ||
        event.workCategory ||
        UNATTRIBUTED_STAGE;
      toolCallsByStage[stage] = (toolCallsByStage[stage] || 0) + 1;
      if (stage === RETRIEVAL_STAGE)
        retrievalCallItemIds.push([...itemIdsNamedByArgs(event.args)]);
    }
    if (event.type === "tool_result") {
      for (const receipt of event.actionReceipts || [])
        for (const fact of receipt.verifiedFacts || []) {
          const noteId = noteIdOfFact(fact);
          if (noteId) writtenNoteIds.add(noteId);
        }
    }
    if (event.type === "batch_item_outcome") {
      batchItemKeys.add(`${event.batchId}::${event.itemKey}`);
      if (event.status === "failed") batchItems.failed += 1;
      else if (event.written) batchItems.written += 1;
      else batchItems.announcedNotWritten += 1;
    }
    if (event.type === "material_finalized") materialFinalized += 1;
  }

  const modelCallsPerTurn = [...extras.modelCalls];
  const modelCallsTotal = modelCallsPerTurn.reduce(
    (total, calls) => total + calls,
    0,
  );
  const nativeWrites = writtenNoteIds.size;
  return {
    modelCallsPerTurn,
    modelCallsTotal,
    modelCallsPerBatchItem: batchItemKeys.size
      ? roundHundredths(
          batchTurnModelCalls(events, extras, modelCallsTotal) /
            batchItemKeys.size,
        )
      : null,
    toolCallsByStage,
    nativeWrites,
    nativeSaves: extras.nativeSaves,
    duplicateNativeWrites: Math.max(0, extras.nativeSaves - nativeWrites),
    batchItems,
    materialFinalized,
    retrieval: summarizeRetrieval(
      retrievalCallItemIds,
      extras.retrievalCounters,
    ),
  };
}

/**
 * One streamed turn as it was driven: a fixed transcript pushed at one delta
 * size, and what the panel was asked to do about it.
 *
 * `blocksReleased` is what the coalescer let through; `refreshesScheduled` is
 * how many repaints those blocks asked for. They are separate counts on
 * purpose: the contract that makes streaming affordable is that they stay
 * equal -- one repaint per readable block -- however small the provider's
 * deltas get.
 */
export type RenderFlightRun = {
  /** The name this run is pinned under. */
  id: string;
  /** Characters the provider handed over at a time. */
  deltaChars: number;
  deltas: number;
  charsPushed: number;
  blocksReleased: number;
  refreshesScheduled: number;
  /** Whether the stalled-stream timer fired between every delta. */
  stallTimerFires: boolean;
};

export type RenderFlightSample = Omit<RenderFlightRun, "id"> & {
  /**
   * Repaints per thousand characters of answer, rounded to two decimals.
   *
   * This is the number that has to stay flat across delta sizes: it is the
   * cost of an answer, not the cost of a provider's chunking.
   */
  refreshesPerKChar: number;
};

/** The pinned render journey: one sample per run, keyed by run id. */
export type RenderFlightSummary = Record<string, RenderFlightSample>;

/**
 * Turns the driven runs into the pinned render journey.
 *
 * Pure over the counts: it neither drives a stream nor knows what released a
 * block, so the rig that produces the counts can change without changing what
 * the numbers mean.
 */
export function summarizeRenderFlight(
  runs: readonly RenderFlightRun[],
): RenderFlightSummary {
  const summary: RenderFlightSummary = {};
  for (const run of runs) {
    summary[run.id] = {
      deltaChars: run.deltaChars,
      deltas: run.deltas,
      charsPushed: run.charsPushed,
      blocksReleased: run.blocksReleased,
      refreshesScheduled: run.refreshesScheduled,
      refreshesPerKChar: run.charsPushed
        ? roundHundredths((run.refreshesScheduled * 1000) / run.charsPushed)
        : 0,
      stallTimerFires: run.stallTimerFires,
    };
  }
  return summary;
}
