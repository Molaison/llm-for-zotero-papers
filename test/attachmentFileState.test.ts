import { assert } from "chai";
import { readAttachmentFileState } from "../src/utils/attachmentFileState";

describe("attachment file state", function () {
  const previousIO = (globalThis as any).IOUtils;
  afterEach(function () {
    (globalThis as any).IOUtils = previousIO;
  });

  it("returns size and mtime from IOUtils.stat", async function () {
    (globalThis as any).IOUtils = {
      stat: async (path: string) => ({
        size: 2048,
        lastModified: 1700000000000,
        path,
      }),
    };
    const item = {
      getFilePathAsync: async () => "/tmp/paper.pdf",
    } as unknown as Zotero.Item;
    assert.deepEqual(await readAttachmentFileState(item), {
      path: "/tmp/paper.pdf",
      size: 2048,
      mtime: 1700000000000,
    });
  });

  it("returns null for a missing file, a linked file without a path, or a stat failure", async function () {
    (globalThis as any).IOUtils = {
      stat: async () => {
        throw new Error("ENOENT");
      },
    };
    assert.isNull(
      await readAttachmentFileState({
        getFilePathAsync: async () => "/tmp/gone.pdf",
      } as unknown as Zotero.Item),
    );
    assert.isNull(
      await readAttachmentFileState({
        getFilePathAsync: async () => false,
      } as unknown as Zotero.Item),
    );
    assert.isNull(await readAttachmentFileState(null));
  });
});
