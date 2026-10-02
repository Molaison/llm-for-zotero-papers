import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { OUTCOME_REASONS } from "../src/agent/loop/outcomes";
import { ExecutionCheckpointFold } from "../src/agent/execution/checkpointEvents";
import { setOriginalAgentPermissionMode } from "../src/agent/originalAgentPermissionMode";
import type { TaskPaperScopeSet } from "../src/agent/context/taskPaperScopeListing";
import type { AgentStepParams } from "../src/agent/model/adapter";
import type {
  AgentConfirmationResolution,
  AgentEvent,
  AgentModelStep,
  AgentPendingAction,
  AgentRuntimeOutcome,
  AgentToolCall,
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/types";
import {
  finalStep,
  installDirectJourneyEnvironment,
  type DirectJourneyEnvironment,
} from "./helpers/materialJourneys";

/**
 * A large reorganization in real turns (Stage 6.5).
 *
 * "Sort the papers in Drift into topic subfolders": the model shows the
 * proposed grouping in the chat before anything changes, creates the topic
 * folders, then moves the papers batch by batch with library_update
 * assignments. The real library_update, its review cards and the action
 * contract run against a small in-memory folder; the model is scripted.
 */

const DRIFT = 6;
const PAPERS = [
  { id: 101, title: "Place cells remap across days" },
  { id: 102, title: "Place field drift in CA1" },
  { id: 103, title: "Stable place codes in CA3" },
  { id: 104, title: "Grid cells in entorhinal cortex" },
  { id: 105, title: "Grid distortion near borders" },
  { id: 106, title: "Grid scale across modules" },
];
const PAPER_IDS = PAPERS.map((paper) => paper.id);
/** The ids the two created folders receive, in creation order. */
const PLACE = 20;
const GRID = 21;
const TOPIC_OF: Record<number, number> = {
  101: PLACE,
  102: PLACE,
  103: PLACE,
  104: GRID,
  105: GRID,
  106: GRID,
};
const REQUEST = "Sort the papers in Drift into topic subfolders.";
const PROPOSAL =
  "Proposed grouping for the 6 papers in Drift:\n- Place cells (3): Place cells remap across days; Place field drift in CA1\n- Grid cells (3): Grid cells in entorhinal cortex; Grid scale across modules\n\nI will create these two subfolders and move the papers in batches.";
const MOVE_PART = "Move papers into the topic subfolders";

type FolderLibrary = {
  gateway: Record<string, unknown>;
  /** The folders each paper is filed in now. */
  membership: Map<number, Set<number>>;
  folderName: (collectionId: number) => string | undefined;
};

/** An annotation on a paper's PDF, which no collection can hold. */
const ANNOTATION = 107;
const ANNOTATION_PDF = 1071;
const ANNOTATION_REASON =
  "Item 107 is an annotation inside an attachment; only top-level items can be filed into collections.";

function installFolderLibrary(
  options: { annotation?: boolean } = {},
): FolderLibrary {
  const membership = new Map<number, Set<number>>(
    PAPER_IDS.map((id) => [id, new Set([DRIFT])]),
  );
  const folders = new Map<number, { name: string; parentID: number | null }>([
    [DRIFT, { name: "Drift", parentID: null }],
  ]);
  let nextFolderId = PLACE;
  const title = (id: number) =>
    PAPERS.find((paper) => paper.id === id)?.title || `Item ${id}`;
  const paperItem = (id: number) =>
    membership.has(id)
      ? {
          id,
          key: `PAPER${id}`,
          libraryID: 1,
          parentID: 0,
          deleted: false,
          isRegularItem: () => true,
          isAttachment: () => false,
          isNote: () => false,
          isAnnotation: () => false,
          getCollections: () => [...membership.get(id)!],
          getField: (field: string) => (field === "title" ? title(id) : ""),
          getDisplayTitle: () => title(id),
        }
      : null;
  // The annotation the live run's own script found: Zotero reports it with a
  // parent (its PDF), and as neither a regular item, a note nor an attachment.
  const annotation =
    options.annotation === true
      ? {
          id: ANNOTATION,
          key: `ANNOT${ANNOTATION}`,
          libraryID: 1,
          parentID: ANNOTATION_PDF,
          deleted: false,
          annotationType: "highlight",
          annotationText: "the authors claim that representations drift",
          isRegularItem: () => false,
          isAttachment: () => false,
          isNote: () => false,
          isAnnotation: () => true,
          getCollections: () => [],
          getField: () => "",
          getDisplayTitle: () => "",
        }
      : null;
  const item = (id: number) =>
    (id === ANNOTATION ? annotation : null) || paperItem(id);
  const summary = (collectionId: number) => {
    const folder = folders.get(collectionId);
    if (!folder) return null;
    const parent = folder.parentID ? folders.get(folder.parentID) : undefined;
    return {
      collectionId,
      libraryID: 1,
      name: folder.name,
      path: parent ? `${parent.name} / ${folder.name}` : folder.name,
    };
  };
  const nativeFolder = (collectionId: number | undefined) => {
    const folder = collectionId ? folders.get(collectionId) : undefined;
    if (!folder || !collectionId) return null;
    return {
      id: collectionId,
      name: folder.name,
      parentID: folder.parentID || false,
      deleted: false,
      getChildItems: () =>
        [...membership]
          .filter(([, filed]) => filed.has(collectionId))
          .map(([id]) => id),
      getChildCollections: () =>
        [...folders]
          .filter(([, child]) => child.parentID === collectionId)
          .map(([id]) => id),
    };
  };
  const gateway = {
    resolveLibraryID: () => 1,
    getItem: item,
    resolveRegularItem: item,
    getCollection: nativeFolder,
    getCollectionSummary: summary,
    listCollectionSummaries: () => [...folders.keys()].map(summary),
    listCurrentCollectionSummaries: () => [...folders.keys()].map(summary),
    getCollectionNativeState: (collectionId: number) => {
      const folder = folders.get(collectionId);
      return {
        exists: Boolean(folder),
        name: folder?.name || "",
        parentCollectionId: folder?.parentID ?? null,
        deleted: false,
      };
    },
    getPaperTargetsByItemIds: (ids: number[]) =>
      ids
        .filter((id) => membership.has(id))
        .map((id) => ({
          itemId: id,
          title: title(id),
          firstCreator: "Author",
          year: "2024",
          attachments: [],
          tags: [],
          collectionIds: [...membership.get(id)!],
        })),
    createCollection: async (params: {
      name: string;
      parentCollectionId?: number;
    }) => {
      const collectionId = nextFolderId++;
      folders.set(collectionId, {
        name: params.name,
        parentID: params.parentCollectionId ?? null,
      });
      return summary(collectionId);
    },
    addItemsToCollections: async (params: {
      assignments: Array<{ itemId: number; targetCollectionId: number }>;
      mode?: "move";
      from?: number | "all";
    }) => {
      // As the real gateway does, an item no collection can hold is refused
      // before anything is written, and the rest of the batch still runs.
      const fileable = params.assignments.filter((assignment) =>
        membership.has(assignment.itemId),
      );
      const priorCollections = fileable.map((assignment) => ({
        itemId: assignment.itemId,
        collectionIds: [...membership.get(assignment.itemId)!],
      }));
      for (const assignment of fileable) {
        const filed = membership.get(assignment.itemId)!;
        if (params.mode === "move" && typeof params.from === "number") {
          filed.delete(params.from);
        }
        filed.add(assignment.targetCollectionId);
      }
      return {
        selectedCount: params.assignments.length,
        movedCount: fileable.length,
        addedCount: 0,
        skippedCount: params.assignments.length - fileable.length,
        collections: [],
        items: params.assignments.map((assignment) =>
          membership.has(assignment.itemId)
            ? {
                itemId: assignment.itemId,
                status: "moved",
                targetCollectionId: assignment.targetCollectionId,
              }
            : {
                itemId: assignment.itemId,
                status: "missing",
                targetCollectionId: assignment.targetCollectionId,
                reason:
                  "Annotations live inside an attachment and cannot be filed or reparented",
              },
        ),
        priorCollections,
      };
    },
  };
  return {
    gateway,
    membership,
    folderName: (collectionId) => folders.get(collectionId)?.name,
  };
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: args } as AgentToolCall;
}

function createFolder(id: string, name: string): AgentToolCall {
  return call(id, "library_update", {
    kind: "collection",
    action: "create",
    name,
    parentCollectionId: DRIFT,
  });
}

/** One batch of moves: each paper to its topic folder, out of Drift. */
function moveBatch(id: string, itemIds: number[]): AgentToolCall {
  return call(id, "library_update", {
    kind: "collections",
    action: "add",
    mode: "move",
    from: DRIFT,
    assignments: itemIds.map((itemId) => ({
      itemId,
      targetCollectionId: TOPIC_OF[itemId],
    })),
  });
}

function declareMoves(id: string): AgentToolCall {
  return call(id, "task_update", {
    tasks: [
      {
        taskId: "move",
        description: MOVE_PART,
        expectedEffect: "mutation",
        expectedCapability: "zotero.collections",
        scope: true,
      },
    ],
  });
}

/** The moves part over ids the model counted itself, as bare ids. */
function declareMovesOf(id: string, itemIds: number[]): AgentToolCall {
  return call(id, "task_update", {
    tasks: [
      {
        taskId: "move",
        description: MOVE_PART,
        expectedEffect: "mutation",
        expectedCapability: "zotero.collections",
        targetIds: itemIds.map(String),
      },
    ],
  });
}

/** Files items into one folder, adding only, as the live run's last call did. */
function fileInto(
  id: string,
  collectionId: number,
  itemIds: number[],
): AgentToolCall {
  return call(id, "library_update", {
    kind: "collections",
    action: "add",
    mode: "add",
    assignments: itemIds.map((itemId) => ({
      itemId,
      targetCollectionId: collectionId,
    })),
  });
}

type ScriptStep =
  | AgentModelStep
  | ((params: AgentStepParams) => Promise<AgentModelStep>);

function stepOf(...calls: AgentToolCall[]): AgentModelStep {
  return {
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  };
}

/** A step whose text streams to the user before its calls run. */
function sayThen(text: string, ...calls: AgentToolCall[]): ScriptStep {
  return async (params) => {
    await params.onTextDelta?.(text);
    return {
      kind: "tool_calls",
      calls,
      assistantMessage: { role: "assistant", content: text, tool_calls: calls },
    };
  };
}

/** How the user answers one review card. */
type Review = (action: AgentPendingAction) => AgentConfirmationResolution;

const approve: Review = () => ({ approved: true });

/** Approve a move card as shown, except the papers left untouched. */
function approveMoves(leaveUntouched: number[] = []): Review {
  return (action) => {
    const field = (action.fields || []).find(
      (entry) => entry.type === "assignment_table",
    ) as
      | { id: string; rows: Array<{ id: string; value?: string }> }
      | undefined;
    if (!field) return { approved: true };
    return {
      approved: true,
      data: {
        [field.id]: field.rows.map((row) => ({
          id: row.id,
          value: leaveUntouched.includes(Number(row.id))
            ? "__skip__"
            : row.value,
          checked: true,
        })),
      },
    };
  };
}

const decline: Review = () => ({ approved: false });

type Turn = {
  outcome?: AgentRuntimeOutcome;
  events: AgentEvent[];
  /** Each review card the user saw, in order. */
  cards: AgentPendingAction[];
};

async function runReorganization(params: {
  conversationKey: number;
  library: FolderLibrary;
  steps: ScriptStep[];
  /** One answer per card, in order. */
  reviews?: Review[];
}): Promise<Turn> {
  const events: AgentEvent[] = [];
  const cards: AgentPendingAction[] = [];
  const reviews = [...(params.reviews || [])];
  const scope: TaskPaperScopeSet = {
    wholeLibrary: false,
    itemIds: PAPER_IDS,
    withText: PAPER_IDS.length,
  };
  let requests = 0;
  const runtime = new AgentRuntime({
    resolveTurnScopePapers: async () => scope,
    registry: createBuiltInToolRegistry({
      zoteroGateway: params.library.gateway as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    }),
    adapterFactory: () => ({
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      supportsTools: () => true,
      async runStep(stepParams: AgentStepParams): Promise<AgentModelStep> {
        const step = params.steps[requests];
        requests += 1;
        if (!step)
          throw new Error(
            `The script ends at ${params.steps.length} steps; the model was asked for step ${requests}.`,
          );
        return typeof step === "function" ? step(stepParams) : step;
      },
    }),
  });
  const outcome = await runtime.runTurn({
    request: {
      conversationKey: params.conversationKey,
      mode: "agent",
      userText: REQUEST,
      libraryID: 1,
      // A library chat with the folder selected: the turn's scope is its papers.
      conversationKind: "global",
      selectedCollectionContexts: [
        { collectionId: DRIFT, libraryID: 1, name: "Drift" },
      ],
      model: "test",
      apiKey: "test",
      apiBase: "https://example.invalid",
      metadata: { sourceMessageTimestamp: params.conversationKey },
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type !== "confirmation_required") return;
      cards.push(event.action);
      const review = reviews.shift();
      assert.exists(
        review,
        `no answer scripted for card "${event.action.title}"`,
      );
      runtime.resolveConfirmation(event.requestId, review!(event.action));
    },
  });
  return { outcome, events, cards };
}

/** The run's ledger, folded from its whole ledger and the deltas after it. */
function settled(turn: Turn): ExecutionCheckpoint {
  const fold = new ExecutionCheckpointFold();
  let last: ExecutionCheckpoint | undefined;
  for (const event of turn.events) {
    if (
      event.type !== "execution_checkpoint" &&
      event.type !== "execution_checkpoint_delta"
    )
      continue;
    last = fold.apply(event);
    assert.exists(last, "every ledger event folds onto the one before");
  }
  assert.exists(last, "the run published its ledger");
  assert.exists(last!.end, "the last checkpoint carries the end state");
  return last!;
}

function movePart(checkpoint: ExecutionCheckpoint): ExecutionCheckpointTask {
  const task = checkpoint.tasks.find(
    (entry) => entry.taskId === `${checkpoint.executionId}:task:move`,
  );
  assert.exists(task, "the declared moves part");
  return task!;
}

function items(ids: number[]): string[] {
  return ids.map((id) => `item:${id}`);
}

function isMoveCall(event: AgentEvent): boolean {
  return (
    event.type === "tool_call" &&
    event.name === "library_update" &&
    (event.args as { kind?: unknown } | undefined)?.kind === "collections"
  );
}

function isWriteCall(event: AgentEvent): boolean {
  return event.type === "tool_call" && event.name === "library_update";
}

function moveCards(turn: Turn): AgentPendingAction[] {
  return turn.cards.filter((card) => card.title === "Move to collection");
}

function rowsOf(card: AgentPendingAction): string[] {
  const field = (card.fields || []).find(
    (entry) => entry.type === "assignment_table",
  ) as { rows: Array<{ id: string }> } | undefined;
  return (field?.rows || []).map((row) => row.id);
}

describe("reorganization flow: sort a folder's papers into topic subfolders", function () {
  let environment: DirectJourneyEnvironment;
  let library: FolderLibrary;
  let conversationKey = 996_000;

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    library = installFolderLibrary();
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
  });

  it("Safe: the grouping shows before any change, each batch is one review, and a declined batch is an exception", async function () {
    setOriginalAgentPermissionMode("safe");
    const turn = await runReorganization({
      conversationKey,
      library,
      steps: [
        sayThen(
          PROPOSAL,
          declareMoves("declare-1"),
          createFolder("create-place", "Place cells"),
          createFolder("create-grid", "Grid cells"),
        ),
        stepOf(moveBatch("batch-1", [101, 102, 104])),
        stepOf(moveBatch("batch-2", [103, 105, 106])),
        finalStep(
          "Moved 3 papers: Place cells (2), Grid cells (1). You declined the second batch, so 3 papers stay in Drift.",
        ),
      ],
      reviews: [approve, approve, approveMoves(), decline],
    });

    assert.equal(turn.outcome?.kind, "completed");
    // The proposal reached the chat before the first write was even proposed.
    const proposalAt = turn.events.findIndex(
      (event) =>
        event.type === "message_delta" &&
        event.text.includes("Place cells (3)"),
    );
    assert.isAbove(proposalAt, -1, "the proposal was streamed");
    assert.isBelow(proposalAt, turn.events.findIndex(isWriteCall));
    assert.isBelow(proposalAt, turn.events.findIndex(isMoveCall));
    assert.isBelow(
      proposalAt,
      turn.events.findIndex((event) => event.type === "confirmation_required"),
    );

    // Two folder cards, then one card per batch of moves, each with its rows.
    assert.deepEqual(
      turn.cards.map((card) => card.title),
      [
        "Create collection",
        "Create collection",
        "Move to collection",
        "Move to collection",
      ],
    );
    assert.deepEqual(moveCards(turn).map(rowsOf), [
      ["101", "102", "104"],
      ["103", "105", "106"],
    ]);

    const ledger = settled(turn);
    const part = movePart(ledger);
    assert.deepEqual(part.targets, items(PAPER_IDS));
    assert.equal(part.status, "completed");
    assert.deepEqual(part.doneTargets, items([101, 102, 104]));
    assert.deepEqual(part.exceptions, [
      { targets: items([103, 105, 106]), reason: OUTCOME_REASONS.declined },
    ]);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });

    assert.equal(library.folderName(PLACE), "Place cells");
    assert.equal(library.folderName(GRID), "Grid cells");
    for (const id of [101, 102, 104])
      assert.deepEqual([...library.membership.get(id)!], [TOPIC_OF[id]]);
    for (const id of [103, 105, 106])
      assert.deepEqual([...library.membership.get(id)!], [DRIFT]);
  });

  it("Safe: papers left untouched in an approved card are excepted, and the rest close the part", async function () {
    setOriginalAgentPermissionMode("safe");
    const turn = await runReorganization({
      conversationKey,
      library,
      steps: [
        sayThen(
          PROPOSAL,
          declareMoves("declare-1"),
          createFolder("create-place", "Place cells"),
          createFolder("create-grid", "Grid cells"),
        ),
        stepOf(moveBatch("batch-all", PAPER_IDS)),
        finalStep(
          "Moved 5 papers. You left Grid scale across modules where it was.",
        ),
      ],
      reviews: [approve, approve, approveMoves([106])],
    });

    assert.lengthOf(moveCards(turn), 1, "one batch, one review");
    const ledger = settled(turn);
    const part = movePart(ledger);
    assert.equal(part.status, "completed");
    assert.deepEqual(part.doneTargets, items([101, 102, 103, 104, 105]));
    assert.deepEqual(part.exceptions, [
      { targets: items([106]), reason: OUTCOME_REASONS.declined },
    ]);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
    assert.deepEqual([...library.membership.get(106)!], [DRIFT]);
  });

  it("Auto: the folders and the moves run without a card, and the receipts close every paper", async function () {
    setOriginalAgentPermissionMode("auto");
    const turn = await runReorganization({
      conversationKey,
      library,
      steps: [
        sayThen(
          PROPOSAL,
          declareMoves("declare-1"),
          createFolder("create-place", "Place cells"),
          createFolder("create-grid", "Grid cells"),
        ),
        stepOf(moveBatch("batch-1", [101, 102, 104])),
        stepOf(moveBatch("batch-2", [103, 105, 106])),
        finalStep("Moved all 6 papers: Place cells (3), Grid cells (3)."),
      ],
    });

    assert.deepEqual(turn.cards, [], "Auto runs what can be undone directly");
    const ledger = settled(turn);
    const part = movePart(ledger);
    assert.equal(part.status, "completed");
    assert.deepEqual(part.doneTargets, items([101, 102, 104, 103, 105, 106]));
    assert.notProperty(part, "exceptions");
    assert.lengthOf(
      part.verifiedReceiptIds,
      2,
      "one verified receipt per batch",
    );
    for (const id of PAPER_IDS)
      assert.deepEqual([...library.membership.get(id)!], [TOPIC_OF[id]]);
  });

  it("Auto: an annotation filed on its own after the papers is excepted with the reason, and the part completes", async function () {
    // The live run: the model's own script counted an annotation among the
    // unfiled items, declared it with the papers, and tried it last.
    setOriginalAgentPermissionMode("auto");
    const annotated = installFolderLibrary({ annotation: true });
    const turn = await runReorganization({
      conversationKey,
      library: annotated,
      steps: [
        sayThen(
          PROPOSAL,
          declareMovesOf("declare-1", [...PAPER_IDS, ANNOTATION]),
          createFolder("create-place", "Place cells"),
          createFolder("create-grid", "Grid cells"),
        ),
        stepOf(moveBatch("batch-1", [101, 102, 104])),
        stepOf(moveBatch("batch-2", [103, 105, 106])),
        stepOf(fileInto("file-annotation", PLACE, [ANNOTATION])),
        finalStep(
          "Moved all 6 papers. The highlight on the first paper is an annotation, which Zotero cannot file into a folder.",
        ),
      ],
    });

    assert.equal(turn.outcome?.kind, "completed");
    const ledger = settled(turn);
    const part = movePart(ledger);
    assert.equal(part.status, "completed");
    assert.deepEqual(part.doneTargets, [
      "101",
      "102",
      "104",
      "103",
      "105",
      "106",
    ]);
    assert.deepEqual(part.exceptions, [
      { targets: [String(ANNOTATION)], reason: ANNOTATION_REASON },
    ]);
    assert.deepEqual(
      ledger.end,
      { state: "completed_with_exceptions" },
      "a refused annotation is an exception, not a decision for the user",
    );
    assert.notOk(
      ledger.tasks.some((task) => task.status === "blocked"),
      "nothing is left blocked",
    );
    for (const id of PAPER_IDS)
      assert.deepEqual([...annotated.membership.get(id)!], [TOPIC_OF[id]]);
  });

  it("Auto: an annotation inside a batch is refused while the batch's papers move", async function () {
    setOriginalAgentPermissionMode("auto");
    const annotated = installFolderLibrary({ annotation: true });
    const mixed = call("batch-2", "library_update", {
      kind: "collections",
      action: "add",
      mode: "move",
      from: DRIFT,
      assignments: [
        ...[103, 105, 106].map((itemId) => ({
          itemId,
          targetCollectionId: TOPIC_OF[itemId],
        })),
        { itemId: ANNOTATION, targetCollectionId: PLACE },
      ],
    });
    const turn = await runReorganization({
      conversationKey,
      library: annotated,
      steps: [
        sayThen(
          PROPOSAL,
          declareMovesOf("declare-1", [...PAPER_IDS, ANNOTATION]),
          createFolder("create-place", "Place cells"),
          createFolder("create-grid", "Grid cells"),
        ),
        stepOf(moveBatch("batch-1", [101, 102, 104])),
        stepOf(mixed),
        finalStep("Moved all 6 papers; the annotation stays with its PDF."),
      ],
    });

    const ledger = settled(turn);
    const part = movePart(ledger);
    assert.equal(part.status, "completed");
    assert.deepEqual(part.doneTargets, [
      "101",
      "102",
      "104",
      "103",
      "105",
      "106",
    ]);
    assert.deepEqual(part.exceptions, [
      { targets: [String(ANNOTATION)], reason: ANNOTATION_REASON },
    ]);
    assert.lengthOf(
      part.verifiedReceiptIds,
      2,
      "the mixed batch's receipt still proves the papers it moved",
    );
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
  });
});
