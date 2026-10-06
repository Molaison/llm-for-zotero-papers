import { assert } from "chai";
import { createZoteroScriptTool } from "../src/agent/tools/write/zoteroScript";
import {
  initAgentChangeJournal,
  JOURNAL_STEPS_TABLE,
} from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";
import { createTestActionContractService } from "./helpers/actionContractService";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * `zotero_script` executes privileged JavaScript against the live Zotero
 * object. Before this suite it ran write-mode scripts with no confirmation
 * card at all, and the trace showed only a model-authored one-line
 * description — so the user approved nothing and could not see what ran.
 *
 * The contract pinned here mirrors `run_command`: the source itself is the
 * confirmation surface, via a `code_preview` field.
 */
describe("zotero_script confirmation", function () {
  const context: AgentToolContext = {
    request: {
      conversationKey: 7,
      mode: "agent",
      userText: "tidy up",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  const tool = createZoteroScriptTool({ allowUnsandboxedTestExecution: true });

  function validated(mode: "read" | "write", script: string) {
    const result = tool.validate({
      access: mode === "read" ? "library" : "privileged",
      effect: mode,
      script,
      description: "Tidy collections",
    });
    assert.isTrue(
      result.ok,
      `fixture should validate: ${JSON.stringify(result)}`,
    );
    if (!result.ok) throw new Error("unreachable");
    return result.value;
  }

  const WRITE_SCRIPT =
    "const items = await Zotero.Items.getAll(1);\nfor (const i of items) { env.snapshot(i); i.addTag('x'); await i.saveTx(); }";

  it("classifies a write-mode script as a state change", async function () {
    const input = validated("write", WRITE_SCRIPT);
    const plan = await tool.planInvocation?.(input, context);
    assert.equal(plan?.mechanism, "zotero_script");
    assert.equal(plan?.impact, "state_change");
    assert.include(plan?.effects || [], "modify");
  });

  it("shows the actual source in a code_preview field, not a summary", async function () {
    const input = validated("write", WRITE_SCRIPT);
    const pending = await tool.createPendingAction?.(input, context);
    assert.exists(pending, "write scripts must render a confirmation card");
    const preview = pending?.fields.find((f) => f.type === "code_preview");
    assert.exists(preview, "expected a code_preview field");
    const value = (preview as never as { value: string }).value;
    assert.equal(value, WRITE_SCRIPT, "the card must show the script verbatim");
    assert.equal(
      (preview as never as { language?: string }).language,
      "javascript",
    );
  });

  it("proves library read mode at the runtime boundary", async function () {
    const input = validated("read", "return Zotero.Items.getAll(1).length;");
    const plan = await tool.planInvocation?.(input, context);
    assert.equal(plan?.mechanism, "zotero_script");
    assert.equal(plan?.impact, "read_only");
    assert.equal(plan?.assurance, "runtime_enforced");
  });

  it("keeps privileged read mode ambiguous", async function () {
    const input = tool.validate({
      access: "privileged",
      effect: "read",
      script: "return Zotero.Items.getAll(1).length;",
      description: "Count items",
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const plan = await tool.planInvocation?.(input.value, context);
    assert.equal(plan?.mechanism, "zotero_script");
    assert.equal(plan?.impact, "ambiguous");
    assert.equal(plan?.assurance, "unknown");
  });
});

/**
 * `mode:'read'` was never a sandbox — the evaluator hands the script the real
 * `Zotero` global either way (`fn(Zotero, env)`). So the note fence, which
 * exists to keep note creation on the validated `note_write` path, has to
 * apply regardless of the mode the model declared.
 *
 * The undo-instrumentation guard deliberately does NOT move: `env.snapshot`
 * is a no-op in read mode, so requiring it there would reject every
 * legitimate read script while preventing no write at all.
 */
describe("zotero_script mode guards", function () {
  const tool = createZoteroScriptTool({ allowUnsandboxedTestExecution: true });
  const NOTE_WRITE_SCRIPT =
    "const n = new Zotero.Item('note'); n.setNote('<p>hi</p>'); await n.saveTx();";

  it("refuses a note write declared as read mode", function () {
    const result = tool.validate({
      access: "library",
      effect: "read",
      script: NOTE_WRITE_SCRIPT,
      description: "Sneak a note in",
    });
    assert.isFalse(
      result.ok,
      "declaring read mode must not be a way around the note fence",
    );
  });

  it("still refuses a note write in write mode", function () {
    const result = tool.validate({
      access: "privileged",
      effect: "write",
      script: `env.snapshot(null); ${NOTE_WRITE_SCRIPT}`,
      description: "Sneak a note in",
    });
    assert.isFalse(result.ok);
  });

  it("still accepts an ordinary read script with no undo instrumentation", function () {
    const result = tool.validate({
      access: "library",
      effect: "read",
      script: "return Zotero.Items.getAll(1).length;",
      description: "Count items",
    });
    assert.isTrue(
      result.ok,
      "read scripts must not be forced to call env.snapshot, which no-ops in read mode",
    );
  });
});

/**
 * The receipt a script write earns.
 *
 * A script's effects cannot be declared in advance, so the journal records
 * what it found immediately afterwards as the step's post-image. The receipt
 * used to ignore that entirely and report `execution_only` — "the script ran"
 * — for a call that had just changed the library.
 *
 * What `verified` claims is narrow on purpose: the objects the journal
 * recorded still hold the state it recorded. That is a statement about state,
 * not about intent, so a script that guarded an item and changed nothing is
 * verified too — which is why the fact says how many targets were compared.
 * The other outcomes each get their own fact suffix, so "could not check" is
 * never filed as "checked and matched".
 */
describe("zotero_script receipt verification", function () {
  const originalZotero = globalThis.Zotero;
  const service = createTestActionContractService();

  const context: AgentToolContext = {
    request: {
      conversationKey: 9,
      mode: "agent",
      userText: "stamp the items",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  /** Lets a test act at an exact durable-write boundary. */
  class ObservableJournalDb extends ChangeJournalTestDb {
    onStatement?: (sql: string, params: unknown[]) => void;
    async queryAsync(sql: string, params: unknown[] = []): Promise<unknown> {
      this.onStatement?.(sql, params);
      return super.queryAsync(sql, params);
    }
  }

  function fakeItem(id: number, read: () => string) {
    return {
      id,
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => true,
      getField: () => "",
      getTags: () => [],
      getCollections: () => [],
      getCreatorsJSON: () => [],
      toJSON: () => ({ itemType: "journalArticle", extra: read() }),
      addTag: () => undefined,
      setField: () => undefined,
      saveTx: async () => undefined,
    };
  }

  async function runScript(params: {
    script: string;
    extra: () => string;
    access?: "library" | "privileged";
    effect?: "read" | "write";
    onStatement?: (
      sql: string,
      params: unknown[],
      db: ObservableJournalDb,
    ) => void;
  }) {
    const db = new ObservableJournalDb();
    const hook = params.onStatement;
    if (hook) db.onStatement = (sql, bound) => hook(sql, bound, db);
    const item = fakeItem(1, params.extra);
    globalThis.Zotero = {
      DB: db,
      Items: { get: (id: number) => (id === 1 ? item : null) },
      Libraries: { userLibraryID: 1 },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const input = tool.validate({
      access: params.access || "library",
      effect: params.effect || "write",
      script: params.script,
      description: "Stamp an audit marker",
    });
    assert.isTrue(input.ok, JSON.stringify(input));
    if (!input.ok) throw new Error("unreachable");
    const prepared = await service.prepare(tool, input.value, context);
    const result = await tool.execute(input.value, context);
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: result.effect,
      content: result.content,
    });
    return { content: result.content as Record<string, unknown>, receipts };
  }

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("verifies a library write whose journalled post-image still holds, and names what it compared", async function () {
    // This script guards one item and changes nothing. The receipt is still
    // verified: it proves the guarded state, not that the script had intent.
    const { receipts } = await runScript({
      script: "env.snapshot(Zotero.Items.get(1)); return 'done';",
      extra: () => "audited",
    });

    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].proofDomain, "execution");
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "applied");
    assert.lengthOf(receipts[0].verifiedFacts, 1);
    assert.match(
      receipts[0].verifiedFacts[0],
      /^script_postcondition:[^:]+:1:satisfied:1 targets$/,
    );
  });

  it("refuses to verify a library write whose effect changed before the receipt", async function () {
    let extra = "audited";
    const { receipts } = await runScript({
      script: "env.snapshot(Zotero.Items.get(1)); return 'done';",
      extra: () => extra,
      // A concurrent edit lands at the exact moment the script's post-image
      // is journalled — after it was captured, before the receipt reads it
      // back. The step UPDATE is that boundary; the INSERT that precedes it
      // happens before the script has even run.
      onStatement: (sql, bound) => {
        if (
          sql.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE}`) &&
          bound.some(
            (value) =>
              typeof value === "string" && value.includes("script_effects"),
          )
        ) {
          extra = "changed by someone else";
        }
      },
    });

    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    assert.lengthOf(receipts[0].verifiedFacts, 1);
    assert.match(
      receipts[0].verifiedFacts[0],
      /^script_postcondition:[^:]+:1:mismatched$/,
      "a mismatch must never be recorded with the satisfied fact",
    );
    assert.match(
      receipts[0].reasons.join(" "),
      /recorded effect could not be confirmed: native state no longer matches/,
    );
  });

  it("records a journal it could not read back as not_re_readable, not as a mismatch", async function () {
    const { receipts } = await runScript({
      script: "env.snapshot(Zotero.Items.get(1)); return 'done';",
      extra: () => "audited",
      // The write succeeded and is journalled; reading the step back fails.
      onStatement: (sql, bound, db) => {
        if (
          sql.startsWith(`UPDATE ${JOURNAL_STEPS_TABLE}`) &&
          bound.some(
            (value) =>
              typeof value === "string" && value.includes("script_effects"),
          )
        ) {
          db.failWhen = (statement) =>
            statement.startsWith(`SELECT * FROM ${JOURNAL_STEPS_TABLE}`)
              ? new Error("journal read failed")
              : null;
        }
      },
    });

    // Conservative: an effect that could not be checked is not verified. But
    // the fact says which of the two it was, so the audit trail does not read
    // as though native state disagreed.
    assert.equal(receipts[0].verification, "unverified");
    assert.lengthOf(receipts[0].verifiedFacts, 1);
    assert.match(
      receipts[0].verifiedFacts[0],
      /^script_postcondition:[^:]+:1:not_re_readable$/,
    );
    assert.match(
      receipts[0].reasons.join(" "),
      /journalled step could not be loaded: journal read failed/,
    );
  });

  it("stays execution_only for a script run that declares no expected effect", async function () {
    // A privileged read is journalled as an irreversible invocation with no
    // post-image: there is nothing to read back, so the receipt says exactly
    // that instead of claiming a verification it does not have.
    const { receipts } = await runScript({
      access: "privileged",
      effect: "read",
      script: "return 'nothing declared';",
      extra: () => "audited",
    });

    assert.equal(receipts[0].verification, "execution_only");
    assert.equal(receipts[0].status, "observed");
    assert.deepEqual(receipts[0].verifiedFacts, []);
  });
});
