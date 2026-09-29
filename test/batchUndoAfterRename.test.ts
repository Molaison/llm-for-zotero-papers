import { assert } from "chai";
import {
  installBatchJournal,
  runAutoTagFixture,
  undoFixture,
} from "./helpers/batchFixtures";

/**
 * Batch actions reach library writes through the model-visible facades, so
 * their durable journal names the facade. Undo must not care which name a
 * journal carries: it replays each step's recorded inverse, so a journal an
 * older build filed under the retired primitive name still reverts.
 */
describe("auto-tag journals under library_update and remains undoable", function () {
  let restore: () => void;

  beforeEach(async function () {
    restore = await installBatchJournal();
  });

  afterEach(function () {
    restore();
  });

  it("records journalToolName library_update and undo restores the tags", async function () {
    const { journal, gateway } = await runAutoTagFixture({ items: 3 });
    assert.equal(journal.toolName, "library_update");
    assert.isNotEmpty(journal.steps);
    assert.equal(journal.steps[0].operation, "apply_tags");
    assert.isNotEmpty(gateway.tagsOf(1), "auto-tag wrote tags to paper 1");

    const undo = await undoFixture(gateway);

    assert.equal(undo.status, "undone");
    assert.equal(undo.actionId, journal.actionId);
    assert.deepEqual(gateway.tagsOf(1), []);
    assert.deepEqual(gateway.tagsOf(2), []);
    assert.deepEqual(gateway.tagsOf(3), []);
  });

  it("still reverts a journal written under the old apply_tags name", async function () {
    const { journal, gateway } = await runAutoTagFixture({
      items: 1,
      legacyJournalToolName: "apply_tags",
    });
    assert.equal(journal.toolName, "apply_tags");
    assert.isNotEmpty(gateway.tagsOf(1), "auto-tag wrote tags to paper 1");

    const undo = await undoFixture(gateway);

    assert.equal(undo.status, "undone");
    assert.equal(undo.toolName, "apply_tags");
    assert.deepEqual(gateway.tagsOf(1), []);
  });
});
