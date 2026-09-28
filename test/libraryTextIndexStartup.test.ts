import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import {
  startLibraryTextIndex,
  stopLibraryTextIndex,
} from "../src/services/libraryTextIndex";
import { setUserIdleForTests } from "../src/services/libraryTextIndex/userIdle";

describe("library text index startup", function () {
  const previous = (globalThis as any).Zotero;
  afterEach(async function () {
    await stopLibraryTextIndex();
    (globalThis as any).Zotero = previous;
    setUserIdleForTests(null);
  });

  it("startLibraryTextIndex never opens a Zotero.DB transaction and never queries Zotero.DB", async function () {
    const harness = installLibraryTextIndexSqlite();
    const calls: string[] = [];
    (globalThis as any).Zotero = {
      ...(previous || {}),
      DB: {
        executeTransaction: async () => {
          calls.push("tx");
        },
        queryAsync: async () => {
          calls.push("q");
          return [];
        },
      },
      Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1 }] },
      Items: { get: () => false },
      Prefs: { get: () => undefined },
    };
    setUserIdleForTests(false);
    try {
      await startLibraryTextIndex({
        getSnapshot: async () =>
          ({
            pdfAttachmentIdsByItemId: new Map(),
            attachmentById: new Map(),
            itemById: new Map(),
          }) as any,
      });
      assert.deepEqual(calls, []);
    } finally {
      // Stop before closing the harness so a queued drain never opens a real connection.
      await stopLibraryTextIndex();
      harness.close();
    }
  });
});
