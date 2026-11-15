import { assert } from "chai";
import { resolveActiveLibraryID } from "../src/utils/zoteroLibraryScope";

describe("active Zotero library selection", function () {
  let originalZotero: typeof Zotero;

  function installPane(pane?: object, userLibraryID: unknown = 1) {
    globalThis.Zotero = {
      getActiveZoteroPane: () => pane,
      Libraries: { userLibraryID },
    } as unknown as typeof Zotero;
  }

  function removedSelector(): never {
    assert.fail("the removed selector must not run when the new API exists");
  }

  beforeEach(function () {
    originalZotero = globalThis.Zotero;
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("uses the current API for a group library without calling the removed API", function () {
    let legacyCalls = 0;
    const pane = {
      getSelectedLibraryIDs() {
        assert.strictEqual(this, pane);
        return [7];
      },
      getSelectedLibraryID() {
        legacyCalls++;
        return removedSelector();
      },
      getSelectedItems: () => [{ libraryID: 1 }],
    };
    installPane(pane);

    assert.equal(resolveActiveLibraryID(), 7);
    assert.equal(legacyCalls, 0);
  });

  it("uses the first selected library and follows selection changes", function () {
    let selected = [7, 9];
    installPane({ getSelectedLibraryIDs: () => selected });

    assert.equal(resolveActiveLibraryID(), 7);
    selected = [9, 7];
    assert.equal(resolveActiveLibraryID(), 9);
  });

  it("uses the legacy API on older Zotero versions", function () {
    const pane = {
      getSelectedLibraryID() {
        assert.strictEqual(this, pane);
        return 7;
      },
      getSelectedItems: () => [{ libraryID: 1 }],
    };
    installPane(pane);

    assert.equal(resolveActiveLibraryID(), 7);
  });

  it("uses the selected item when the current API has no selection", function () {
    installPane({
      getSelectedLibraryIDs: () => [],
      getSelectedLibraryID: removedSelector,
      getSelectedItems: () => [{ libraryID: 9 }],
    });

    assert.equal(resolveActiveLibraryID(), 9);
  });

  it("uses the selected item when neither library API exists", function () {
    installPane({ getSelectedItems: () => [{ libraryID: 9 }] });

    assert.equal(resolveActiveLibraryID(), 9);
  });

  for (const invalid of [undefined, null, false, 0, -1, NaN]) {
    it(`falls back to the selected item for an invalid library ID (${invalid})`, function () {
      installPane({
        getSelectedLibraryIDs: () => [invalid],
        getSelectedLibraryID: removedSelector,
        getSelectedItems: () => [{ libraryID: 9 }],
      });

      assert.equal(resolveActiveLibraryID(), 9);
    });
  }

  it("uses the personal library when there is no selection", function () {
    installPane({
      getSelectedLibraryIDs: () => [],
      getSelectedLibraryID: removedSelector,
      getSelectedItems: () => [],
    });

    assert.equal(resolveActiveLibraryID(), 1);
  });

  it("uses the personal library when there is no active pane", function () {
    installPane();

    assert.equal(resolveActiveLibraryID(), 1);
  });

  it("keeps the personal-library fallback if the pane API throws", function () {
    let legacyCalls = 0;
    installPane({
      getSelectedLibraryIDs: () => {
        throw new Error("pane not ready");
      },
      getSelectedLibraryID: () => {
        legacyCalls++;
        return 7;
      },
    });

    assert.equal(resolveActiveLibraryID(), 1);
    assert.equal(legacyCalls, 0);
  });

  it("returns null when no library is available", function () {
    installPane(undefined, null);

    assert.isNull(resolveActiveLibraryID());
  });
});
