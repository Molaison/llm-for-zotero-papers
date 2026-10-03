import { assert } from "chai";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import {
  applyOutcomeEvidence,
  declareOutcomes,
  decideRunEnd,
  OUTCOME_REASONS,
  type OutcomeEvidence,
} from "../src/agent/loop/outcomes";
import { createSubmitDocumentTool } from "../src/agent/tools/control/submitDocument";
import type {
  AgentExecutionContext,
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/types";

/**
 * Papers a submitted document leaves out (`submit_document` `excluded`): the
 * tool takes them by id with a reason, and the ledger records them on the
 * part the document binds to, leniently, because the document is final.
 */

const executionContext: AgentExecutionContext = {
  version: 1,
  executionId: "execution-doc-1",
  conversationKey: 53,
  conversationGeneration: 1,
  chatLibraryID: 1,
  permissionOwner: "original_agent",
  workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
  configuredAccess: { libraryIDs: [1], outputDirectories: [] },
};

const RUN = { status: "completed", stopRule: "final_answer" } as const;
const off = "Economics paper; it does not address path integration";

const BASE = {
  title: "Path integration review",
  markdown: "# Path integration review\n\nText.",
  citations: [],
  quotes: [],
  assets: [],
  groundingReviewed: "passed",
  groundingIssues: [],
};

function validate(args: unknown) {
  return createSubmitDocumentTool({} as never).validate!(args);
}

function declared(targets?: string[]): ExecutionCheckpoint {
  return declareOutcomes(
    createEmptyExecutionCheckpoint(executionContext, 10),
    [
      {
        taskId: "review",
        description: "Write the literature review",
        effect: "artifact",
        ...(targets ? { targets } : {}),
      },
    ],
    20,
  );
}

function review(checkpoint: ExecutionCheckpoint): ExecutionCheckpointTask {
  const task = checkpoint.tasks.find(
    (entry) => entry.taskId === "execution-doc-1:task:review",
  );
  assert.exists(task, "the review part");
  return task!;
}

function document(
  cited: string[],
  excluded?: Array<{ targets: string[]; reason: string }>,
  documentId = "doc-1",
): OutcomeEvidence {
  return {
    kind: "material",
    materialRef: {
      documentId,
      documentVersion: 1,
      contentHash: `sha256:${documentId}`,
    },
    taskId: "review",
    documentKind: "literature_review",
    citedTargets: cited,
    ...(excluded ? { excluded } : {}),
  };
}

function apply(
  checkpoint: ExecutionCheckpoint,
  evidence: OutcomeEvidence,
  now = 40,
) {
  return applyOutcomeEvidence(checkpoint, evidence, now);
}

describe("submit_document: papers the document leaves out", function () {
  describe("input", function () {
    it("takes excluded papers by Zotero id with a reason, as item ids", function () {
      const schema = createSubmitDocumentTool({} as never).spec
        .inputSchema as any;
      assert.isFalse(schema.additionalProperties);
      assert.notInclude(schema.required, "excluded", "excluded is optional");
      assert.deepEqual(schema.properties.excluded.items.required, [
        "targetIds",
        "reason",
      ]);
      assert.isFalse(schema.properties.excluded.items.additionalProperties);
      const parsed = validate({
        ...BASE,
        taskId: "review",
        excluded: [
          { targetIds: ["7", "item:9", " 7 "], reason: ` ${off} ` },
          { targetIds: ["item:12"], reason: "A duplicate record" },
        ],
      });
      assert.isTrue(parsed.ok);
      if (!parsed.ok) return;
      assert.deepEqual(parsed.value.excluded, [
        { targetIds: ["item:7", "item:9"], reason: off },
        { targetIds: ["item:12"], reason: "A duplicate record" },
      ]);
      assert.equal(parsed.value.taskId, "review");
    });

    it("validates a document without excluded, or with an empty list, as before", function () {
      for (const args of [BASE, { ...BASE, excluded: [] }]) {
        const parsed = validate(args);
        assert.isTrue(parsed.ok, JSON.stringify(args));
        if (parsed.ok) assert.notProperty(parsed.value, "excluded");
      }
    });

    it("rejects an entry without a reason, without ids, or with ids that are not paper ids", function () {
      for (const [excluded, message] of [
        [[{ targetIds: ["7"] }], /excluded\[0\] needs a reason/],
        [[{ targetIds: ["7"], reason: "  " }], /excluded\[0\] needs a reason/],
        [[{ targetIds: [], reason: off }], /excluded\[0\] needs targetIds/],
        [[{ reason: off }], /excluded\[0\] needs targetIds/],
        [
          [
            { targetIds: ["7"], reason: off },
            { targetIds: ["Smith 2020", "collection:3"], reason: off },
          ],
          /excluded\[1\]\.targetIds take Zotero item ids \(12 or item:12\).*"Smith 2020", "collection:3"/,
        ],
        [["item:7"], /excluded\[0\] must be an object/],
        ["item:7", /excluded must be an array/],
      ] as const) {
        const result = validate({ ...BASE, excluded });
        assert.isFalse(result.ok, JSON.stringify(excluded));
        if (!result.ok) assert.match(result.error, message);
      }
    });
  });

  describe("ledger", function () {
    it("records the papers on a reasoning part the document names when no artifact part takes it", function () {
      const ledger = declareOutcomes(
        createEmptyExecutionCheckpoint(executionContext, 10),
        [
          {
            taskId: "review",
            description: "Synthesize the per-paper results into a review",
            effect: "answer",
            targets: ["item:5", "item:6", "item:7"],
          },
        ],
        20,
      );
      const result = apply(
        ledger,
        document(["item:5", "item:6"], [{ targets: ["7", "5"], reason: off }]),
      );
      assert.isTrue(result.changed);
      const part = review(result.checkpoint);
      assert.deepEqual(
        part.excludedTargets,
        [{ targets: ["item:7"], reason: off }],
        "the cited item:5 is not left out",
      );
      assert.equal(
        part.status,
        "pending",
        "the answer completes it, as before",
      );
      assert.deepEqual(part.materialRefs, [], "the document binds nowhere");
      // A document naming no part, or with nothing left out, changes nothing.
      assert.isFalse(
        apply(ledger, {
          ...document(["item:5"], [{ targets: ["7"], reason: off }]),
          taskId: undefined,
        }).changed,
      );
      assert.isFalse(apply(ledger, document(["item:5"])).changed);
    });

    it("records the papers on the review part, never one the document cites or the part does not name, and the run ends completed", function () {
      const result = apply(
        declared(["item:5", "item:6", "item:7", "item:8"]),
        document(
          ["item:5", "item:6"],
          [{ targets: ["7", "item:8", "item:5", "item:99"], reason: off }],
        ),
      );
      assert.isTrue(result.changed);
      const part = review(result.checkpoint);
      assert.equal(part.status, "completed");
      assert.deepEqual(part.doneTargets, ["item:5", "item:6"]);
      assert.deepEqual(
        part.excludedTargets,
        [{ targets: ["item:7", "item:8"], reason: off }],
        "a cited paper is one the document used; item:99 is not the part's",
      );
      assert.notProperty(part, "exceptions", "no paper is Not covered");
      assert.equal(decideRunEnd(result.checkpoint, RUN), "completed");
    });

    it("moves a Not covered paper to the exclusion, keeps an excluded paper's first reason, and ignores a paper already done", function () {
      let ledger = apply(
        declared(["item:5", "item:6", "item:7", "item:8"]),
        document(["item:5"]),
      ).checkpoint;
      assert.deepEqual(review(ledger).exceptions, [
        {
          targets: ["item:6", "item:7", "item:8"],
          reason: OUTCOME_REASONS.notCovered,
        },
      ]);
      // A revision of the document leaves item:7 out.
      ledger = apply(
        ledger,
        document(["item:5"], [{ targets: ["7"], reason: off }], "doc-2"),
      ).checkpoint;
      let part = review(ledger);
      assert.deepEqual(part.exceptions, [
        { targets: ["item:6", "item:8"], reason: OUTCOME_REASONS.notCovered },
      ]);
      assert.deepEqual(part.excludedTargets, [
        { targets: ["item:7"], reason: off },
      ]);
      assert.deepEqual(
        part.materialRefs.map((ref) => ref.documentId),
        ["doc-1", "doc-2"],
      );
      assert.equal(
        decideRunEnd(ledger, RUN),
        "completed_with_exceptions",
        "item:6 and item:8 are still Not covered",
      );
      // The same document again, now leaving out the rest: what it repeats
      // keeps its first reason, and a paper it covered is not left out.
      const again = apply(
        ledger,
        document(
          ["item:5"],
          [
            { targets: ["item:7", "6"], reason: "Another reason" },
            { targets: ["8", "5"], reason: off },
          ],
          "doc-2",
        ),
      );
      assert.isTrue(again.changed, "the bound document's new exclusions apply");
      part = review(again.checkpoint);
      assert.notProperty(part, "exceptions");
      assert.deepEqual(part.excludedTargets, [
        { targets: ["item:7", "item:8"], reason: off },
        { targets: ["item:6"], reason: "Another reason" },
      ]);
      assert.deepEqual(part.doneTargets, ["item:5"]);
      assert.lengthOf(part.materialRefs, 2, "binding it again adds no ref");
      assert.equal(decideRunEnd(again.checkpoint, RUN), "completed");
      // Applying the same evidence once more changes nothing.
      const repeat = apply(
        again.checkpoint,
        document(
          ["item:5"],
          [
            { targets: ["item:7", "6"], reason: "Another reason" },
            { targets: ["8", "5"], reason: off },
          ],
          "doc-2",
        ),
      );
      assert.isFalse(repeat.changed);
      assert.strictEqual(repeat.checkpoint, again.checkpoint);
    });

    it("on a review declared without papers, records any item id the document does not cite and completes it whole", function () {
      const result = apply(
        declared(),
        document(
          ["item:5", "item:9"],
          [{ targets: ["7", "item:9", "collection:3"], reason: off }],
        ),
      );
      const part = review(result.checkpoint);
      assert.equal(part.status, "completed");
      assert.deepEqual(part.excludedTargets, [
        { targets: ["item:7"], reason: off },
      ]);
      assert.notProperty(part, "exceptions");
      assert.equal(decideRunEnd(result.checkpoint, RUN), "completed");
    });

    it("keeps the reason task_update gave a paper the document also leaves out", function () {
      const ledger = declared(["item:5", "item:6", "item:7"]);
      // As task_update left it: item:7 excluded with its reason.
      const excludedFirst = {
        ...ledger,
        tasks: ledger.tasks.map((task) => ({
          ...task,
          excludedTargets: [{ targets: ["item:7"], reason: off }],
        })),
      };
      const part = review(
        apply(
          excludedFirst,
          document(
            ["item:5"],
            [{ targets: ["7", "6"], reason: "Out of scope" }],
          ),
        ).checkpoint,
      );
      assert.deepEqual(part.excludedTargets, [
        { targets: ["item:7"], reason: off },
        { targets: ["item:6"], reason: "Out of scope" },
      ]);
      assert.notProperty(part, "exceptions");
    });

    it("records nothing when the document binds to no part", function () {
      const reading = declareOutcomes(
        createEmptyExecutionCheckpoint(executionContext, 10),
        [
          {
            taskId: "review",
            description: "Summarize each paper",
            effect: "digest",
            targets: ["item:5", "item:7"],
          },
        ],
        20,
      );
      const result = apply(
        reading,
        document(["item:5"], [{ targets: ["7"], reason: off }]),
      );
      assert.isFalse(result.changed);
      assert.strictEqual(result.checkpoint, reading);
    });

    it("a document without excluded binds as before", function () {
      const ledger = declared(["item:5", "item:6", "item:7"]);
      const without = apply(ledger, document(["item:5"])).checkpoint;
      const withEmpty = apply(ledger, document(["item:5"], [])).checkpoint;
      assert.deepEqual(withEmpty, without);
      const part = review(without);
      assert.equal(part.status, "completed");
      assert.deepEqual(part.doneTargets, ["item:5"]);
      assert.deepEqual(part.exceptions, [
        { targets: ["item:6", "item:7"], reason: OUTCOME_REASONS.notCovered },
      ]);
      assert.notProperty(part, "excludedTargets");
      // The same document again changes nothing.
      const repeat = apply(without, document(["item:5"]));
      assert.isFalse(repeat.changed);
      assert.strictEqual(repeat.checkpoint, without);
    });
  });
});
