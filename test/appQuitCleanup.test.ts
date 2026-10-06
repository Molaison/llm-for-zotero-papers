import { assert } from "chai";
import { installZoteroDbConnectionFake } from "./helpers/libraryTextIndexDb";
import {
  closeLibraryTextIndexDb,
  resetLibraryTextIndexQuitForTests,
} from "../src/services/libraryTextIndex/db";
import {
  startLibraryTextIndex,
  stopLibraryTextIndex,
} from "../src/services/libraryTextIndex";
import {
  getLibraryTextIndexStore,
  resetLibraryTextIndexStoreForTests,
} from "../src/services/libraryTextIndex/store";
import {
  CodexAppServerProcess,
  destroyAllCachedCodexAppServerProcesses,
  getOrCreateCodexAppServerProcess,
} from "../src/utils/codexAppServerProcess";

/**
 * bootstrap.js skips onShutdown when Zotero quits, and Zotero's exit waits
 * for every open Sqlite connection. Background work must stop and close its
 * handles from an AsyncShutdown blocker instead, or the process outlives the
 * window.
 */
describe("cleanup when Zotero quits", function () {
  const globals = globalThis as any;
  let previousZotero: unknown;
  let previousChromeUtils: unknown;
  let blockers: Map<string, () => Promise<void>>;

  const blockerNamed = (part: string) =>
    [...blockers.entries()].find(([name]) => name.includes(part))?.[1];

  beforeEach(function () {
    previousZotero = globals.Zotero;
    previousChromeUtils = globals.ChromeUtils;
    blockers = new Map();
    globals.ChromeUtils = {
      importESModule: () => ({
        AsyncShutdown: {
          profileBeforeChange: {
            addBlocker: (name: string, blocker: () => Promise<void>) => {
              blockers.set(name, blocker);
            },
            removeBlocker: (blocker: () => Promise<void>) => {
              for (const [name, value] of blockers) {
                if (value === blocker) blockers.delete(name);
              }
            },
          },
        },
      }),
    };
  });

  afterEach(async function () {
    await stopLibraryTextIndex();
    await closeLibraryTextIndexDb();
    resetLibraryTextIndexQuitForTests();
    resetLibraryTextIndexStoreForTests();
    globals.Zotero = previousZotero;
    globals.ChromeUtils = previousChromeUtils;
  });

  describe("library text index", function () {
    const emptySnapshot = async () =>
      ({
        pdfAttachmentIdsByItemId: new Map(),
        attachmentById: new Map(),
        itemById: new Map(),
      }) as any;

    function installZotero() {
      const fake = installZoteroDbConnectionFake();
      globals.Zotero = {
        DBConnection: fake.FakeZoteroDBConnection,
        DataDirectory: { dir: "/tmp" },
        Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1 }] },
        Items: { get: () => false },
        // Off, so startup never reconciles; the quit path is the same.
        Prefs: {
          get: (key: string) =>
            key.endsWith(".libraryTextIndexEnabled") ? false : undefined,
        },
      };
      return fake;
    }

    it("closes its database at quit and never reopens it", async function () {
      const fake = installZotero();
      assert.isNotNull(await getLibraryTextIndexStore());
      await startLibraryTextIndex({ getSnapshot: emptySnapshot });

      const blocker = blockerNamed("library text index");
      assert.isFunction(blocker);
      await blocker!();

      assert.lengthOf(fake.instances, 1);
      assert.deepEqual(fake.instances[0].closes, [true]);
      // A late search or job after the close must not open a new handle.
      assert.isNull(await getLibraryTextIndexStore());
      assert.lengthOf(fake.instances, 1);
    });

    it("an orderly stop removes the quit blocker", async function () {
      installZotero();
      await startLibraryTextIndex({ getSnapshot: emptySnapshot });
      assert.isFunction(blockerNamed("library text index"));
      await stopLibraryTextIndex();
      assert.isUndefined(blockerNamed("library text index"));
    });
  });

  describe("codex app-server", function () {
    it("kills cached app-server processes at quit", async function () {
      // Earlier suites may have spawned without AsyncShutdown available.
      await destroyAllCachedCodexAppServerProcesses();
      const originalSpawn = CodexAppServerProcess.spawn;
      let kills = 0;
      let spawns = 0;
      CodexAppServerProcess.spawn = async () => {
        spawns += 1;
        return CodexAppServerProcess.forTest({
          stdin: { write: () => {} },
          kill: () => {
            kills += 1;
          },
        });
      };
      try {
        await getOrCreateCodexAppServerProcess("quit-a");
        await getOrCreateCodexAppServerProcess("quit-b");

        const blocker = blockerNamed("codex app-server");
        assert.isFunction(blocker);
        await blocker!();

        assert.equal(kills, 2);
        await getOrCreateCodexAppServerProcess("quit-a");
        assert.equal(spawns, 3, "the cache was emptied");
      } finally {
        CodexAppServerProcess.spawn = originalSpawn;
        await destroyAllCachedCodexAppServerProcesses();
      }
    });
  });
});
