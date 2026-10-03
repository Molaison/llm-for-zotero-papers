import { mineruLegacyHealth } from "../test/helpers/mineruLegacyHealth";
import { parsePdfWithMineru } from "../src/services/mineru/mineruParser";
import { assert } from "chai";
import { zipSync } from "fflate";
import {
  MineruPageLimitError,
  MineruCancelledError,
} from "../src/utils/mineruClient";
import {
  openPdfSplitter,
  PdfSplitterCancelledError,
} from "../src/utils/pdfSplitter";
import { createPdfFixture } from "../test/helpers/pdfFixture";
import { createEncryptedPdfFixture } from "../test/helpers/encryptedPdfFixture";

// Zotero's own PDF engine independently checks the files produced by pdf-lib.
describe("workflow: bundled MinerU PDF splitter", function () {
  this.timeout(60000);
  it("writes 200 + 200 + 1 pages that Zotero can read in original order", async function () {
    const session = await openPdfSplitter(createPdfFixture(401));
    const io = (globalThis as any).IOUtils;
    const paths: string[] = [];
    const items: Zotero.Item[] = [];
    try {
      assert.equal(session.pageCount, 401);
      for (const [start, end] of [
        [1, 200],
        [201, 400],
        [401, 401],
      ]) {
        const path = PathUtils.join(
          Zotero.getTempDirectory().path,
          `splitter-${Date.now()}-${start}.pdf`,
        );
        paths.push(path);
        await io.write(path, await session.extractPages(start, end));
        const item = await Zotero.Attachments.linkFromFile({
          file: path,
          contentType: "application/pdf",
        });
        items.push(item);
        const readback = await (Zotero as any).PDFWorker.getFullText(
          item.id,
          null,
        );
        assert.equal(readback.totalPages, end - start + 1);
        const markers = Array.from(
          String(readback.text).matchAll(/PAGE\s+(\d+)/g),
          (match) => Number(match[1]),
        );
        assert.deepEqual(
          markers,
          Array.from({ length: end - start + 1 }, (_, i) => start + i),
        );
      }
    } finally {
      session.close();
      for (const item of items) await item.eraseTx();
      for (const path of paths) await io.remove(path, { ignoreAbsent: true });
    }
  });

  it("runs the real split/upload/merge flow and removes temporary files", async function () {
    const io = (globalThis as any).IOUtils;
    const temp = Zotero.getTempDirectory().path;
    const path = PathUtils.join(temp, `mineru-pipeline-${Date.now()}.pdf`);
    const prefix = "extensions.zotero.llmforzotero.";
    const settings: Record<string, string | boolean> = {
      mineruMode: "local",
      mineruLocalBackend: "hybrid",
      mineruForceOcr: true,
      mineruLocalApiBase: "http://127.0.0.1:8000",
    };
    const previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(prefix + key, true),
      ]),
    );
    const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const originalGetGlobal = toolkit.getGlobal;
    const originalToolkit = (globalThis as any).ztoolkit;
    const uploads: string[] = [];
    const encoder = new TextEncoder();
    const existingChunks = (await io.getChildren(temp)).filter((p: string) =>
      PathUtils.filename(p).startsWith("mineru-chunks-"),
    );
    try {
      (globalThis as any).ztoolkit = toolkit;
      for (const [key, value] of Object.entries(settings))
        Zotero.Prefs.set(prefix + key, value, true);
      await io.write(path, createPdfFixture(401));
      toolkit.getGlobal = function (name: string) {
        if (name !== "fetch") return originalGetGlobal.call(this, name);
        return async (url: string, init: RequestInit) => {
          const health = mineruLegacyHealth(String(url));
          if (health) return health;
          assert.equal(String(url), "http://127.0.0.1:8000/file_parse");
          const body = init.body as any;
          if (typeof body.get === "function") {
            assert.equal(body.get("backend"), "hybrid-engine");
            assert.equal(body.get("parse_method"), "ocr");
            uploads.push(body.get("files").name);
          } else {
            const text = new TextDecoder().decode(body);
            assert.include(text, "hybrid-engine");
            assert.include(text, "\r\nocr\r\n");
            uploads.push(/filename="([^"]+)"/.exec(text)![1]);
          }
          const data = zipSync({
            "full.md": encoder.encode(`Part ${uploads.length}`),
            "content_list.json": encoder.encode(
              JSON.stringify([{ type: "text", page_idx: 0 }]),
            ),
          });
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/zip" },
            arrayBuffer: async () => data.buffer,
          };
        };
      };
      const result = await parsePdfWithMineru(path, undefined, undefined, {
        maxPages: 0,
      });
      assert.isNotNull(result);
      assert.lengthOf(uploads, 3);
      assert.equal(
        new Set(uploads).size,
        3,
        "each chunk gets a distinct safe upload name",
      );
      for (const name of uploads) assert.match(name, /^[a-zA-Z0-9-]+\.pdf$/);
      assert.match(result!.mdContent, /Part 1[\s\S]+Part 2[\s\S]+Part 3/);
      const content = result!.files.find(
        (file) => file.relativePath === "content_list.json",
      )!;
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(content.data)).map(
          (item: any) => item.page_idx,
        ),
        [0, 200, 400],
      );
      let limitError: unknown;
      try {
        await parsePdfWithMineru(path, undefined, undefined, { maxPages: 200 });
      } catch (error) {
        limitError = error;
      }
      assert.instanceOf(limitError, MineruPageLimitError);
      assert.lengthOf(uploads, 3, "over-limit document never uploads");
      const controller = new AbortController();
      let cancelError: unknown;
      try {
        await parsePdfWithMineru(
          path,
          (stage) => {
            if (stage.startsWith("Splitting PDF")) controller.abort();
          },
          controller.signal,
        );
      } catch (error) {
        cancelError = error;
      }
      assert.instanceOf(cancelError, MineruCancelledError);
      assert.deepEqual(
        (await io.getChildren(temp)).filter((p: string) =>
          PathUtils.filename(p).startsWith("mineru-chunks-"),
        ),
        existingChunks,
      );
    } finally {
      toolkit.getGlobal = originalGetGlobal;
      if (originalToolkit === undefined) delete (globalThis as any).ztoolkit;
      else (globalThis as any).ztoolkit = originalToolkit;
      for (const [key, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, value, true);
      }
      await io.remove(path, { ignoreAbsent: true });
    }
  });

  it("rejects an encrypted PDF explicitly", async function () {
    let error: unknown;
    try {
      await openPdfSplitter(createEncryptedPdfFixture());
    } catch (caught) {
      error = caught;
    }
    assert.include((error as Error)?.message, "unencrypted copy");
  });

  it("terminates a pending extraction on cancellation", async function () {
    const controller = new AbortController();
    const session = await openPdfSplitter(
      createPdfFixture(401),
      controller.signal,
    );
    try {
      const pending = session.extractPages(1, 200);
      controller.abort();
      let error: unknown;
      try {
        await pending;
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, PdfSplitterCancelledError);
    } finally {
      session.close();
    }
  });
});
