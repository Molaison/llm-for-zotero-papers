import { assert } from "chai";
import { createPdfFixture } from "../test/helpers/pdfFixture";
import {
  getMineruCacheDir,
  getMineruItemDir,
  readCachedMineruMd,
  readManifest,
  writeMineruCacheFiles,
  invalidateMineruMd,
} from "../src/services/mineru/mineruCache";

describe("workflow: MinerU cache upgrade", function () {
  it("reads all supported old cache layouts and publishes a complete replacement through native storage", async function () {
    const io = (globalThis as any).IOUtils;
    const source = PathUtils.join(
      Zotero.DataDirectory.dir,
      `mineru-upgrade-${Date.now()}.pdf`,
    );
    await io.write(source, createPdfFixture(1));
    const item = await Zotero.Attachments.linkFromFile({
      file: source,
      contentType: "application/pdf",
    });
    const original = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    try {
      for (const layout of ["single-file", "content-md", "full-md"]) {
        await invalidateMineruMd(item.id);
        const root = getMineruItemDir(item.id);
        await io.makeDirectory(root, {
          createAncestors: true,
          ignoreExisting: true,
        });
        const path =
          layout === "single-file"
            ? PathUtils.join(getMineruCacheDir(), `${item.id}.md`)
            : PathUtils.join(
                root,
                layout === "content-md" ? "_content.md" : "full.md",
              );
        const old = `# Existing ${layout}\n\nPreserved text.`;
        await io.write(path, new TextEncoder().encode(old));
        assert.equal(await readCachedMineruMd(item.id), old);
        if (layout === "full-md") {
          const legacyManifest = {
            sections: [],
            allFigures: [],
            allTables: [],
            totalChars: old.length,
            noSections: true,
          };
          await io.write(
            PathUtils.join(root, "manifest.json"),
            new TextEncoder().encode(JSON.stringify(legacyManifest)),
          );
          assert.deepEqual(await readManifest(item.id), legacyManifest);
        }
        await writeMineruCacheFiles(
          item.id,
          "# Replacement\n\nComplete output.",
          [],
          { pageCount: 1 },
        );
        assert.equal(
          await readCachedMineruMd(item.id),
          "# Replacement\n\nComplete output.",
        );
        assert.equal((await readManifest(item.id))?.totalPages, 1);
        assert.isFalse(
          await io.exists(PathUtils.join(root, "_llm_write_pending.json")),
        );
        if (layout !== "full-md") assert.isFalse(await io.exists(path));
      }
    } finally {
      await invalidateMineruMd(item.id);
      await item.eraseTx();
      await io.remove(source, { ignoreAbsent: true });
      (globalThis as any).ztoolkit = original;
    }
  });
});
