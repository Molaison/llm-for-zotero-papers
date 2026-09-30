import { assert } from "chai";
import { AgentRuntime } from "../../src/agent/runtime";
import { AgentToolRegistry } from "../../src/agent/tools/registry";
import { createSubmitDocumentTool } from "../../src/agent/tools/control/submitDocument";
import { createNoteWriteTool } from "../../src/agent/tools/write/noteWrite";
import { createNoteWriteBatchTool } from "../../src/agent/tools/write/noteWriteBatch";
import { createUndoTool } from "../../src/agent/tools/write/undo";
import { initPlanDocumentStore } from "../../src/agent/documents/store";
import { clearAgentTranscriptStore } from "../../src/agent/store/transcriptStore";
import { initAgentChangeJournal } from "../../src/agent/store/changeJournal";
import { initAgentBatchItemStore } from "../../src/agent/store/batchItemStore";
import { initAgentBatchJobStore } from "../../src/agent/store/batchJobStore";
import { setOriginalAgentPermissionMode } from "../../src/agent/originalAgentPermissionMode";
import { installMockDb, installAgentStoreSqlite } from "./agentRuntimeMockDb";
import { installNativeNoteStore } from "./nativeNoteStore";
import { createTestActionContractService } from "./actionContractService";
import type { MaterialRef } from "../../src/agent/documents/materialRef";
import type { ZoteroGateway } from "../../src/agent/services/zoteroGateway";
import type {
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
} from "../../src/agent/types";
import type { AgentStepParams } from "../../src/agent/model/adapter";

/**
 * The drivers behind the two material journeys.
 *
 * `test/directMaterialJourney.test.ts` and `test/batchMaterialJourney.test.ts`
 * own the assertions; this module owns everything that makes the turns happen
 * -- the library fixture, the registry, the scripted adapter and the turn
 * scripts themselves -- so a third reader (the flight baselines) can replay the
 * exact same journeys without a second copy of the script drifting away from
 * the one the acceptance tests run.
 *
 * The scripted-turn rig itself -- `runJourneyTurn`, the two step builders and
 * `collectRun` -- is exported because it is not about material at all: it is
 * "run one turn against a fixed script and keep everything it emitted", which
 * is what any scripted journey needs. `test/helpers/retrievalJourney.ts`
 * builds its own registry and script on top of it.
 *
 * The journeys are phased rather than run end to end: each phase is one turn,
 * and the caller drives the phases itself. That is what lets the acceptance
 * tests keep asserting on live mid-journey state (how many notes exist after
 * the failed item, what the journal says before the resume) while the
 * baselines runner simply plays every phase in order.
 */

/** The unsaved-material host block header. */
export const MATERIAL_HEADER =
  "Finalized material available (not saved as a note):";
/** The same header, under the name the direct journey calls it. */
export const BLOCK_HEADER = MATERIAL_HEADER;
/** The resumable-batch host block header. */
export const BATCH_HEADER = "Resumable note batches:";

/** The paper the direct journey writes its note onto. */
export const PARENT_ITEM_ID = 42;
export const DOCUMENT_TITLE = "Representational drift";

/** The papers the batch journey writes a note onto. */
export const PAPER_IDS = [1, 2, 3] as const;
/** The paper whose note the native store refuses on the first attempt. */
export const REFUSED_PAPER_ID = 2;

export type JourneyTurn = {
  outcome: Awaited<ReturnType<AgentRuntime["runTurn"]>>;
  events: AgentEvent[];
  /** The messages handed to the adapter, one entry per generation step. */
  prompts: AgentModelMessage[][];
  /** The request the turn actually ran with, including its material ledger. */
  request: AgentRuntimeRequest | undefined;
  /** Generation steps this turn consumed. */
  steps: number;
};

/** What a replayed journey hands a reader that only wants to measure it. */
export type MaterialJourneyRun = {
  turns: JourneyTurn[];
  /** Every event of the journey, in order, across all of its turns. */
  events: AgentEvent[];
  /** Generation steps per turn: the model-call count at the adapter seam. */
  modelCalls: number[];
  /** Physical native note writes that reached the store. */
  nativeSaves: number;
};

export function finalStep(text: string): AgentModelStep {
  return {
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  };
}

export function toolCallStep(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): AgentModelStep {
  const call = { id: callId, name, arguments: args };
  return {
    kind: "tool_calls",
    calls: [call],
    assistantMessage: { role: "assistant", content: "", tool_calls: [call] },
  };
}

export function firstEvent<TType extends AgentEvent["type"]>(
  events: readonly AgentEvent[],
  type: TType,
): Extract<AgentEvent, { type: TType }> | undefined {
  return events.find((event) => event.type === type) as
    | Extract<AgentEvent, { type: TType }>
    | undefined;
}

export function eventsOfType<TType extends AgentEvent["type"]>(
  events: readonly AgentEvent[],
  type: TType,
): Extract<AgentEvent, { type: TType }>[] {
  return events.filter((event) => event.type === type) as Extract<
    AgentEvent,
    { type: TType }
  >[];
}

export function toolResultFor(
  events: readonly AgentEvent[],
  name: string,
): Extract<AgentEvent, { type: "tool_result" }> | undefined {
  return events.find(
    (event) => event.type === "tool_result" && event.name === name,
  ) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
}

/** The unsaved-material block as the model actually received it. */
export function materialBlock(
  prompts: AgentModelMessage[][],
): string | undefined {
  for (const messages of prompts) {
    const message = messages.find((entry) =>
      String(entry.content).includes(BLOCK_HEADER),
    );
    if (message) return String(message.content);
  }
  return undefined;
}

/** A host block as the model actually received it. */
export function hostBlock(
  prompts: AgentModelMessage[][],
  header: string,
): { content: string; transient: boolean; next: string } | undefined {
  for (const messages of prompts) {
    const index = messages.findIndex((entry) =>
      String(entry.content).includes(header),
    );
    if (index < 0) continue;
    return {
      content: String(messages[index].content),
      transient: Boolean(
        (messages[index] as { transient?: boolean }).transient,
      ),
      next: String(messages[index + 1]?.content ?? ""),
    };
  }
  return undefined;
}

/**
 * Runs one turn against a fixed script.
 *
 * The script is the contract: asking for a step the script does not have
 * fails the turn, which is what proves a journey never regenerated material it
 * had already finalized.
 */
export async function runJourneyTurn(params: {
  registry: AgentToolRegistry;
  conversationKey: number;
  userText: string;
  sourceMessageTimestamp: number;
  /**
   * A step may be computed from the messages the model was given, for a script
   * that names an identity the host minted earlier in the same turn.
   */
  steps: Array<
    AgentModelStep | ((messages: AgentModelMessage[]) => AgentModelStep)
  >;
  approve?: boolean;
}): Promise<JourneyTurn> {
  const events: AgentEvent[] = [];
  const prompts: AgentModelMessage[][] = [];
  let resolvedRequest: AgentRuntimeRequest | undefined;
  let index = 0;
  const runtime = new AgentRuntime({
    registry: params.registry,
    adapterFactory: (resolved) => ({
      getCapabilities: () => ({
        streaming: false,
        toolCalls: true,
        multimodal: false,
      }),
      supportsTools: () => true,
      async runStep(stepParams: AgentStepParams): Promise<AgentModelStep> {
        resolvedRequest = resolved;
        prompts.push(stepParams.messages);
        const step = params.steps[index];
        index += 1;
        if (!step)
          throw new Error(
            `The journey script ends at ${params.steps.length} steps; the model was asked to generate a step ${index}.`,
          );
        return typeof step === "function" ? step(stepParams.messages) : step;
      },
    }),
  });
  const outcome = await runtime.runTurn({
    request: {
      conversationKey: params.conversationKey,
      mode: "agent",
      userText: params.userText,
      libraryID: 1,
      model: "test",
      apiKey: "test",
      apiBase: "https://example.invalid",
      metadata: { sourceMessageTimestamp: params.sourceMessageTimestamp },
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === "confirmation_required")
        runtime.resolveConfirmation(event.requestId, params.approve !== false);
    },
  });
  return { outcome, events, prompts, request: resolvedRequest, steps: index };
}

export function collectRun(
  turns: JourneyTurn[],
  nativeSaves: number,
): MaterialJourneyRun {
  return {
    turns,
    events: turns.flatMap((turn) => turn.events),
    modelCalls: turns.map((turn) => turn.steps),
    nativeSaves,
  };
}

// --------------------------------------------------------------------------
// The direct material journey: author in one turn, save in the next.
// --------------------------------------------------------------------------

export type DirectJourneyLibrary = {
  notes: Map<number, any>;
  failNextNativeSave: (enabled: boolean) => void;
  /** Physical native writes that reached the store, counted at `onSave`. */
  nativeSaves: () => number;
  restore: () => void;
};

const submitDocumentGateway = {
  formatStructuredCitations: () => ({
    styleId: "apa",
    styleTitle: "APA",
    locale: "en-US",
    clusters: [],
    bibliographyEntries: [],
  }),
} as unknown as ZoteroGateway;

/** The library the direct journey writes into: one regular paper and its notes. */
export function installDirectJourneyLibrary(): DirectJourneyLibrary {
  let failNativeSave = false;
  let nativeSaves = 0;
  const native = installNativeNoteStore({
    startId: 500,
    onSave: () => {
      if (failNativeSave)
        throw new Error("The native note write never reached the database.");
      nativeSaves += 1;
    },
  });
  const zotero = globalThis.Zotero as unknown as Record<string, any>;
  const parent = {
    id: PARENT_ITEM_ID,
    key: "PAPER42",
    libraryID: 1,
    deleted: false,
    isRegularItem: () => true,
    isNote: () => false,
    isAttachment: () => false,
    getDisplayTitle: () => "Drift in the hippocampus",
  };
  const notes = native.notes;
  zotero.Items = {
    get: (id: number) => (id === PARENT_ITEM_ID ? parent : notes.get(id)),
    getByLibraryAndKey: (libraryID: number, key: string) =>
      key === parent.key
        ? parent
        : [...notes.values()].find(
            (note) => note.libraryID === libraryID && note.key === key,
          ) || null,
  };
  zotero.Libraries = { userLibraryID: 1 };
  return {
    notes,
    failNextNativeSave: (enabled: boolean) => {
      failNativeSave = enabled;
    },
    nativeSaves: () => nativeSaves,
    restore: native.restore,
  };
}

export function createDirectJourneyRegistry(): AgentToolRegistry {
  const noteGateway = {
    getItem: (itemId: number) => (globalThis.Zotero as any).Items.get(itemId),
    getCollectionSummary: () => null,
  } as unknown as ZoteroGateway;
  const registry = new AgentToolRegistry(
    createTestActionContractService(
      (itemId) => (globalThis.Zotero as any).Items.get(itemId) || null,
    ),
  );
  registry.register(createSubmitDocumentTool(submitDocumentGateway));
  registry.register(createNoteWriteTool(noteGateway));
  return registry;
}

function submitDocumentStep(callId: string): AgentModelStep {
  return toolCallStep(callId, "submit_document", {
    documentKind: "guide",
    integrityPolicy: "authored",
    title: DOCUMENT_TITLE,
    markdown: `# ${DOCUMENT_TITLE}\n\nA complete guide.`,
    citations: [],
    quotes: [],
    assets: [],
    groundingReviewed: "passed",
    groundingIssues: [],
  });
}

function noteWriteStep(callId: string, documentId: string): AgentModelStep {
  return toolCallStep(callId, "note_write", {
    mode: "create",
    documentId,
    targetItemId: PARENT_ITEM_ID,
  });
}

export type DirectMaterialJourney = {
  /** Turn 1: the model authors the material and the turn ends there. */
  authorMaterial: () => Promise<{
    turn: JourneyTurn;
    materialRef: MaterialRef;
  }>;
  /** Turn 2: the save turn. It never regenerates; it names the document. */
  saveAsNote: (options?: {
    callId?: string;
    finalText?: string;
    /** Make the native write fail before it reaches the database. */
    failNativeWrite?: boolean;
  }) => Promise<JourneyTurn>;
  /** The turn after a failed write: the model retries the same documentId. */
  retrySave: () => Promise<JourneyTurn>;
  /** A plain turn after the save, which must be told nothing is pending. */
  acknowledge: () => Promise<JourneyTurn>;
};

export function beginDirectMaterialJourney(
  library: DirectJourneyLibrary,
  conversationKey: number,
): DirectMaterialJourney {
  let materialRef: MaterialRef | undefined;
  let turnIndex = 0;
  const runTurn = (userText: string, steps: AgentModelStep[]) => {
    turnIndex += 1;
    return runJourneyTurn({
      registry: createDirectJourneyRegistry(),
      conversationKey,
      userText,
      sourceMessageTimestamp: turnIndex * 100,
      steps,
    });
  };
  return {
    async authorMaterial() {
      const turn = await runTurn("Write a guide about representational drift", [
        submitDocumentStep("submit-document-1"),
      ]);
      assert.equal(turn.outcome.kind, "completed");
      const announced = firstEvent(turn.events, "material_finalized");
      assert.exists(announced, "turn 1 must announce the finalized material");
      materialRef = announced!.materialRef;
      return { turn, materialRef };
    },
    async saveAsNote(options = {}) {
      if (options.failNativeWrite) library.failNextNativeSave(true);
      try {
        return await runTurn("Save that as a note on the paper", [
          noteWriteStep(
            options.callId ?? "note-write-1",
            materialRef!.documentId,
          ),
          finalStep(options.finalText ?? "Saved it to the paper."),
        ]);
      } finally {
        if (options.failNativeWrite) library.failNextNativeSave(false);
      }
    },
    async retrySave() {
      return runTurn("Try again", [
        noteWriteStep("note-write-2", materialRef!.documentId),
        finalStep("Saved it on the retry."),
      ]);
    },
    async acknowledge() {
      return runTurn("Thanks", [finalStep("You are welcome.")]);
    },
  };
}

export type DirectJourneyEnvironment = {
  library: DirectJourneyLibrary;
  restore: () => void;
};

/** Installs the stores and the library one direct-journey turn needs. */
export async function installDirectJourneyEnvironment(): Promise<DirectJourneyEnvironment> {
  clearAgentTranscriptStore();
  const restoreDb = installMockDb();
  const restoreDocuments = installAgentStoreSqlite();
  const library = installDirectJourneyLibrary();
  const originalToolkit = (globalThis as any).ztoolkit;
  (globalThis as any).ztoolkit = { log: () => undefined };
  setOriginalAgentPermissionMode("safe");
  await initPlanDocumentStore();
  await initAgentChangeJournal();
  return {
    library,
    restore: () => {
      (globalThis as any).ztoolkit = originalToolkit;
      library.restore();
      restoreDocuments();
      restoreDb();
    },
  };
}

/**
 * Replays the direct journey end to end, for a reader that only measures it.
 *
 * Exactly the phases `test/directMaterialJourney.test.ts` asserts on, in the
 * same order, on a private environment of its own.
 */
export async function runDirectMaterialJourney(): Promise<MaterialJourneyRun> {
  const environment = await installDirectJourneyEnvironment();
  try {
    const journey = beginDirectMaterialJourney(environment.library, 880_101);
    const { turn: first } = await journey.authorMaterial();
    const second = await journey.saveAsNote();
    const third = await journey.acknowledge();
    return collectRun(
      [first, second, third],
      environment.library.nativeSaves(),
    );
  } finally {
    environment.restore();
  }
}

// --------------------------------------------------------------------------
// The batch material journey: three notes, one refusal, a resume and an undo.
// --------------------------------------------------------------------------

export type BatchJourneyLibrary = {
  notes: Map<number, any>;
  trashed: number[][];
  refuseNoteFor: (parentId: number | undefined) => void;
  /**
   * Trash this paper's note the instant Zotero stores it.
   *
   * The write still lands -- the mutation window captures a note that exists,
   * so the whole-set postcondition holds -- but the receipt's own re-read,
   * which happens after the call returns, finds a note that is no longer live.
   * That is the only way to reproduce "the write landed, the receipt could not
   * read it back" without reaching into the contract.
   */
  trashNoteFor: (parentId: number | undefined) => void;
  /** Physical native writes that reached the store, counted at `onSave`. */
  nativeSaves: () => number;
  restore: () => void;
};

/** The library the batch journey writes into: three papers and the notes it adds. */
export function installBatchJourneyLibrary(): BatchJourneyLibrary {
  let refusedParent: number | undefined;
  let trashedParent: number | undefined;
  let nativeSaves = 0;
  const native = installNativeNoteStore({
    startId: 500,
    onSave: (note: { parentID?: number; deleted?: boolean }) => {
      if (note.parentID !== undefined && note.parentID === refusedParent)
        throw new Error("Zotero refused the note write");
      if (note.parentID !== undefined && note.parentID === trashedParent)
        note.deleted = true;
      nativeSaves += 1;
    },
  });
  const papers = new Map(
    PAPER_IDS.map((id) => [
      id,
      {
        id,
        key: `PAPER${id}`,
        libraryID: 1,
        parentID: false,
        deleted: false,
        version: 1,
        dateModified: "2026-09-11 10:00:00",
        isRegularItem: () => true,
        isNote: () => false,
        isAttachment: () => false,
        getDisplayTitle: () => `Paper ${id}`,
        getField: () => "",
        getTags: () => [],
        getCollections: () => [],
        getAttachments: () => [],
        getNotes: () => [],
        async reload() {},
      },
    ]),
  );
  const notes = native.notes;
  const zotero = globalThis.Zotero as unknown as Record<string, any>;
  zotero.Items = {
    get: (id: number) =>
      papers.get(id as (typeof PAPER_IDS)[number]) || notes.get(id) || null,
    getByLibraryAndKey: (libraryID: number, key: string) =>
      [...papers.values(), ...notes.values()].find(
        (entry: any) => entry.libraryID === libraryID && entry.key === key,
      ) || null,
  };
  zotero.Libraries = { userLibraryID: 1 };
  const library: BatchJourneyLibrary = {
    notes,
    trashed: [],
    refuseNoteFor: (parentId: number | undefined) => {
      refusedParent = parentId;
    },
    trashNoteFor: (parentId: number | undefined) => {
      trashedParent = parentId;
    },
    nativeSaves: () => nativeSaves,
    restore: native.restore,
  };
  return library;
}

/** The gateway the batch and undo tools share, reading the live library. */
function batchJourneyGateway(library: BatchJourneyLibrary): ZoteroGateway {
  return {
    resolveLibraryID: () => 1,
    getItem: (itemId: number) =>
      (globalThis.Zotero as any).Items.get(itemId) || null,
    getCollectionSummary: () => null,
    formatStructuredCitations: () => ({
      styleId: "apa",
      styleTitle: "APA",
      locale: "en-US",
      clusters: [],
      bibliographyEntries: [],
    }),
    trashItems: async ({ itemIds }: { itemIds: number[] }) => {
      library.trashed.push([...itemIds]);
      for (const itemId of itemIds) {
        const note = library.notes.get(itemId);
        if (note) note.deleted = true;
      }
      return {
        trashedCount: itemIds.length,
        items: itemIds.map((itemId) => ({ itemId, status: "trashed" })),
      };
    },
  } as unknown as ZoteroGateway;
}

function createBatchJourneyRegistry(
  library: BatchJourneyLibrary,
): AgentToolRegistry {
  const gateway = batchJourneyGateway(library);
  const registry = new AgentToolRegistry(
    createTestActionContractService(
      (itemId) => (globalThis.Zotero as any).Items.get(itemId) || null,
    ),
  );
  registry.register(createNoteWriteBatchTool(gateway));
  registry.register(createUndoTool(gateway));
  return registry;
}

export type BatchMaterialJourney = {
  /**
   * Turn 1: one call carries all three bodies, and Zotero refuses paper 2.
   *
   * `refuseParentId: null` lets every note land instead, for a reader that
   * needs a batch whose whole-set postcondition holds.
   */
  writeThreeNotes: (options?: {
    refuseParentId?: number | null;
  }) => Promise<JourneyTurn>;
  /** Turn 2: the model continues the batch by name; no body is authored twice. */
  finishTheRest: () => Promise<JourneyTurn>;
  /** Turn 3: one undo reverts the whole set. */
  undoThem: () => Promise<JourneyTurn>;
};

export function beginBatchMaterialJourney(
  library: BatchJourneyLibrary,
  conversationKey: number,
): BatchMaterialJourney {
  let batchId: string | undefined;
  let turnIndex = 0;
  const runTurn = (userText: string, steps: AgentModelStep[]) => {
    turnIndex += 1;
    return runJourneyTurn({
      registry: createBatchJourneyRegistry(library),
      conversationKey,
      userText,
      sourceMessageTimestamp: turnIndex * 100,
      steps,
    });
  };
  return {
    async writeThreeNotes(options?: { refuseParentId?: number | null }) {
      const refused =
        options?.refuseParentId === undefined
          ? REFUSED_PAPER_ID
          : options.refuseParentId;
      library.refuseNoteFor(refused === null ? undefined : refused);
      try {
        const turn = await runTurn(
          "Write a summary note on each of these three papers",
          [
            toolCallStep("note-batch-1", "note_write_batch", {
              notes: PAPER_IDS.map((id) => ({
                targetItemId: id,
                content: `# Paper ${id}\n\nSummary of paper ${id}.`,
              })),
            }),
            finalStep("I wrote two of the three notes."),
          ],
        );
        batchId = eventsOfType(turn.events, "batch_item_outcome")[0]?.batchId;
        return turn;
      } finally {
        library.refuseNoteFor(undefined);
      }
    },
    async finishTheRest() {
      return runTurn("Finish the rest", [
        toolCallStep("note-batch-2", "note_write_batch", {
          resumeBatchId: batchId,
        }),
        finalStep("All three notes are written."),
      ]);
    },
    async undoThem() {
      return runTurn("Undo that", [
        toolCallStep("undo-1", "undo", {}),
        finalStep("I removed all three notes."),
      ]);
    },
  };
}

export type BatchJourneyEnvironment = {
  library: BatchJourneyLibrary;
  restore: () => void;
};

/** Installs the stores and the library one batch-journey turn needs. */
export async function installBatchJourneyEnvironment(): Promise<BatchJourneyEnvironment> {
  clearAgentTranscriptStore();
  const restoreDb = installMockDb();
  const restoreStores = installAgentStoreSqlite();
  const library = installBatchJourneyLibrary();
  const originalToolkit = (globalThis as any).ztoolkit;
  (globalThis as any).ztoolkit = { log: () => undefined };
  setOriginalAgentPermissionMode("safe");
  await initPlanDocumentStore();
  await initAgentBatchJobStore();
  await initAgentBatchItemStore();
  await initAgentChangeJournal();
  return {
    library,
    restore: () => {
      (globalThis as any).ztoolkit = originalToolkit;
      library.restore();
      restoreStores();
      restoreDb();
    },
  };
}

/**
 * Replays the batch journey end to end, for a reader that only measures it.
 *
 * Exactly the phases `test/batchMaterialJourney.test.ts` asserts on, in the
 * same order, on a private environment of its own.
 */
export async function runBatchMaterialJourney(): Promise<MaterialJourneyRun> {
  const environment = await installBatchJourneyEnvironment();
  try {
    const journey = beginBatchMaterialJourney(environment.library, 881_101);
    const first = await journey.writeThreeNotes();
    const second = await journey.finishTheRest();
    const third = await journey.undoThem();
    return collectRun(
      [first, second, third],
      environment.library.nativeSaves(),
    );
  } finally {
    environment.restore();
  }
}
