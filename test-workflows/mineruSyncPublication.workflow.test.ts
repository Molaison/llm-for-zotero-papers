import { assert } from "chai";
import { createPdfFixture } from "../test/helpers/pdfFixture";
import { composeRetrievalCandidateInvalidation } from "../test/helpers/hostSurfaces";
import {
  getMineruItemDir,
  hasCachedMineruMd,
  invalidateMineruMd,
  readCachedMineruMd,
  writeMineruCacheFiles,
} from "../src/services/mineru/mineruCache";
import {
  ensureMineruRuntimeCacheForAttachment,
  publishMineruCachePackageForAttachment,
  repairSyncedMineruCacheForAttachment,
} from "../src/services/mineru/sync";

describe("workflow: MinerU sync during cache publication", function () {
  // The library index restores synced caches in the background through the
  // plugin's own copy of the cache module, whose write lock this bundle's
  // writes do not share. Pause it so only this test writes the cache.
  const indexPref = "extensions.zotero.llmforzotero.libraryTextIndexEnabled";
  let oldIndex: unknown;
  before(function () {
    oldIndex = Zotero.Prefs.get(indexPref, true);
    Zotero.Prefs.set(indexPref, false, true);
  });
  after(function () {
    if (oldIndex === undefined) Zotero.Prefs.clear(indexPref, true);
    else Zotero.Prefs.set(indexPref, oldIndex as boolean, true);
  });

  it("preserves a fresh parse during restore/repair and recovers an interrupted write through native storage", async function () {
    const io = (globalThis as any).IOUtils;
    const source = PathUtils.join(
      Zotero.DataDirectory.dir,
      `mineru-sync-${Date.now()}.pdf`,
    );
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "MinerU publication race fixture");
    await parent.saveTx();
    await io.write(source, createPdfFixture(1));
    const pdf = await Zotero.Attachments.linkFromFile({
      file: source,
      parentItemID: parent.id,
      contentType: "application/pdf",
    });
    const originalToolkit = (globalThis as any).ztoolkit;
    const pref = "extensions.zotero.llmforzotero.mineruSyncEnabled";
    const oldSync = Zotero.Prefs.get(pref, true);
    const restoreInvalidator = composeRetrievalCandidateInvalidation();
    let packageId: number | undefined;
    try {
      (globalThis as any).ztoolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
      Zotero.Prefs.set(pref, true, true);
      const old = "# Old extraction\n\nSynced before reparsing.";
      await writeMineruCacheFiles(pdf.id, old, []);
      const published = await publishMineruCachePackageForAttachment(pdf.id);
      assert.equal(published.status, "published", published.reason);
      packageId = published.packageAttachmentId;
      const packageItem = await Zotero.Items.getAsync(packageId!);
      assert.equal(packageItem.parentID, parent.id);
      assert.isTrue(await io.exists(await packageItem.getFilePathAsync()));
      const root = getMineruItemDir(pdf.id);
      const marker = PathUtils.join(root, "_llm_write_pending.json");
      const fresh = "# New extraction\n\nComplete reparsed output.";
      await writeMineruCacheFiles(pdf.id, fresh, [], {
        pageCount: 1,
        beforeCommit: async () => {
          assert.isTrue(await io.exists(marker));
          assert.isFalse(await hasCachedMineruMd(pdf.id));
          for (const restore of [
            ensureMineruRuntimeCacheForAttachment,
            repairSyncedMineruCacheForAttachment,
          ]) {
            assert.equal((await restore(pdf)).status, "busy");
            assert.isTrue(await io.exists(marker));
            assert.isNull(await readCachedMineruMd(pdf.id));
          }
        },
      });
      assert.equal(
        await Zotero.File.getContentsAsync(PathUtils.join(root, "full.md")),
        fresh,
      );
      const manifest = JSON.parse(
        (await Zotero.File.getContentsAsync(
          PathUtils.join(root, "manifest.json"),
        )) as string,
      );
      assert.equal(manifest.totalChars, fresh.length);
      assert.equal(manifest.totalPages, 1);
      assert.isFalse(await io.exists(marker));
      try {
        await writeMineruCacheFiles(pdf.id, "# Interrupted", [], {
          beforeCommit: async () => {
            throw new Error("fixture interruption");
          },
        });
        assert.fail("expected interrupted write");
      } catch (error) {
        assert.include(String(error), "fixture interruption");
      }
      assert.isTrue(await io.exists(marker));
      const restored = await ensureMineruRuntimeCacheForAttachment(pdf);
      assert.equal(restored.status, "restored", restored.reason);
      assert.equal(
        await Zotero.File.getContentsAsync(PathUtils.join(root, "full.md")),
        old,
      );
      assert.isFalse(await io.exists(marker));
    } finally {
      await invalidateMineruMd(pdf.id);
      if (packageId) await (await Zotero.Items.getAsync(packageId)).eraseTx();
      await pdf.eraseTx();
      await parent.eraseTx();
      await io.remove(source, { ignoreAbsent: true });
      if (oldSync === undefined) Zotero.Prefs.clear(pref, true);
      else Zotero.Prefs.set(pref, oldSync, true);
      restoreInvalidator();
      (globalThis as any).ztoolkit = originalToolkit;
    }
  });
});
