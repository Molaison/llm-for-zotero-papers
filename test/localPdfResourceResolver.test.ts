import { assert } from "chai";
import { createLocalPdfResourceResolver } from "../src/modules/contextPanel/setupHandlers/controllers/localPdfResourceResolver";
import type { PaperContextRef } from "../src/shared/types";

function paper(overrides: Partial<PaperContextRef> = {}): PaperContextRef {
  return {
    itemId: 10,
    contextItemId: 20,
    title: "Selected paper",
    contentSourceMode: "pdf",
    ...overrides,
  };
}

async function expectRejected(
  promise: Promise<unknown>,
  messagePart: string,
): Promise<void> {
  try {
    await promise;
    assert.fail("expected promise to reject");
  } catch (error) {
    assert.include(
      error instanceof Error ? error.message : String(error),
      messagePart,
    );
  }
}

describe("local PDF resource resolver", function () {
  it("rejects non-PDF source identities before touching Zotero items", async function () {
    let lookups = 0;
    const resolver = createLocalPdfResourceResolver({
      getItemById: () => {
        lookups += 1;
        return null;
      },
    });

    await expectRejected(
      resolver.resolve([paper({ contentSourceMode: "text" })]),
      "explicitly selected PDF source",
    );
    assert.equal(lookups, 0);
  });

  it("resolves only the exact selected child attachment", async function () {
    const items = new Map<number, any>([
      [10, { id: 10, isRegularItem: () => true }],
      [
        20,
        {
          id: 20,
          parentID: 10,
          attachmentContentType: "application/pdf",
          attachmentFilename: "selected.pdf",
          isAttachment: () => true,
          getFilePathAsync: async () => "/papers/selected.pdf ",
        },
      ],
      [
        21,
        {
          id: 21,
          parentID: 10,
          attachmentContentType: "application/pdf",
          attachmentFilename: "sibling.pdf",
          isAttachment: () => true,
          getFilePathAsync: async () => "/papers/sibling.pdf",
        },
      ],
    ]);
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) => items.get(id) || null,
      inspectFile: async () => ({
        size: 128,
        type: "regular",
        header: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      }),
    });

    const resources = await resolver.resolve([paper()]);

    assert.deepEqual(resources, [
      {
        kind: "local_pdf",
        sourceKey: "zotero-pdf:10:20",
        itemId: 10,
        contextItemId: 20,
        title: "Selected paper",
        name: "selected.pdf",
        mimeType: "application/pdf",
        absolutePath: "/papers/selected.pdf ",
      },
    ]);
  });

  it("preserves order for multiple PDFs with identical filenames", async function () {
    const items = new Map<number, any>([
      [10, { id: 10, isRegularItem: () => true }],
      [11, { id: 11, isRegularItem: () => true }],
      [
        20,
        {
          id: 20,
          parentID: 10,
          attachmentContentType: "application/pdf",
          attachmentFilename: "paper.pdf",
          isAttachment: () => true,
          getFilePathAsync: async () => "/α papers/paper.pdf",
        },
      ],
      [
        21,
        {
          id: 21,
          parentID: 11,
          attachmentContentType: "application/pdf",
          attachmentFilename: "paper.pdf",
          isAttachment: () => true,
          getFilePathAsync: async () => "/b/paper.pdf",
        },
      ],
    ]);
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) => items.get(id) || null,
      inspectFile: async () => ({
        size: 10,
        type: "regular",
        header: new TextEncoder().encode("%PDF-"),
      }),
    });

    const resources = await resolver.resolve([
      paper(),
      paper({ itemId: 11, contextItemId: 21, title: "Second" }),
    ]);

    assert.deepEqual(
      resources.map((resource) => [resource.sourceKey, resource.absolutePath]),
      [
        ["zotero-pdf:10:20", "/α papers/paper.pdf"],
        ["zotero-pdf:11:21", "/b/paper.pdf"],
      ],
    );
  });

  it("preserves Windows drive and UNC paths exactly", async function () {
    const paths = new Map<number, string>([
      [20, "C:\\Papers\\paper.pdf"],
      [21, "\\\\server\\share\\paper.pdf"],
    ]);
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) => {
        if (id === 10 || id === 11) {
          return { id, isRegularItem: () => true } as any;
        }
        const path = paths.get(id);
        if (!path) return null;
        return {
          id,
          parentID: id === 20 ? 10 : 11,
          attachmentContentType: "application/pdf",
          attachmentFilename: "paper.pdf",
          isAttachment: () => true,
          getFilePathAsync: async () => path,
        } as any;
      },
      inspectFile: async () => ({
        size: 10,
        type: "regular",
        header: new TextEncoder().encode("%PDF-"),
      }),
    });

    const resources = await resolver.resolve([
      paper(),
      paper({ itemId: 11, contextItemId: 21 }),
    ]);

    assert.deepEqual(
      resources.map((resource) => resource.absolutePath),
      ["C:\\Papers\\paper.pdf", "\\\\server\\share\\paper.pdf"],
    );
  });

  it("re-resolves a moved attachment path on each request", async function () {
    let currentPath = "/old/paper.pdf";
    const attachment = {
      id: 20,
      parentID: 10,
      attachmentContentType: "application/pdf",
      attachmentFilename: "paper.pdf",
      isAttachment: () => true,
      getFilePathAsync: async () => currentPath,
    };
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) =>
        id === 10
          ? ({ id: 10, isRegularItem: () => true } as any)
          : id === 20
            ? (attachment as any)
            : null,
      inspectFile: async () => ({
        size: 10,
        type: "regular",
        header: new TextEncoder().encode("%PDF-"),
      }),
    });

    const first = await resolver.resolve([paper()]);
    currentPath = "/new/paper.pdf";
    const second = await resolver.resolve([paper()]);

    assert.equal(first[0].absolutePath, "/old/paper.pdf");
    assert.equal(second[0].absolutePath, "/new/paper.pdf");
  });

  it("resolves a standalone PDF only when both identities match", async function () {
    const attachment = {
      id: 30,
      parentID: 0,
      attachmentContentType: "application/pdf",
      attachmentFilename: "standalone.pdf",
      isAttachment: () => true,
      getFilePathAsync: async () => "/papers/standalone.pdf",
    };
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) => (id === 30 ? (attachment as any) : null),
      inspectFile: async () => ({
        size: 10,
        type: "regular",
        header: new TextEncoder().encode("%PDF-"),
      }),
    });

    const resources = await resolver.resolve([
      paper({ itemId: 30, contextItemId: 30 }),
    ]);

    assert.equal(resources[0].sourceKey, "zotero-pdf:30:30");
    await expectRejected(
      resolver.resolve([paper({ itemId: 10, contextItemId: 30 })]),
      "Standalone PDF identity",
    );
  });

  it("rejects trashed attachments and trashed parent papers", async function () {
    const parent = { id: 10, deleted: false, isRegularItem: () => true };
    const attachment = {
      id: 20,
      parentID: 10,
      deleted: true,
      attachmentContentType: "application/pdf",
      attachmentFilename: "paper.pdf",
      isAttachment: () => true,
      getFilePathAsync: async () => "/papers/paper.pdf",
    };
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) =>
        id === 10 ? (parent as any) : id === 20 ? (attachment as any) : null,
      inspectFile: async () => ({
        size: 10,
        type: "regular",
        header: new TextEncoder().encode("%PDF-"),
      }),
    });

    await expectRejected(resolver.resolve([paper()]), "Zotero trash");
    attachment.deleted = false;
    parent.deleted = true;
    await expectRejected(resolver.resolve([paper()]), "parent paper");
  });

  it("rejects duplicate identities atomically", async function () {
    const attachment = {
      id: 20,
      parentID: 10,
      attachmentContentType: "application/pdf",
      attachmentFilename: "paper.pdf",
      isAttachment: () => true,
      getFilePathAsync: async () => "/paper.pdf",
    };
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) =>
        id === 10
          ? ({ id: 10, isRegularItem: () => true } as any)
          : id === 20
            ? (attachment as any)
            : null,
      inspectFile: async () => ({
        size: 10,
        type: "regular",
        header: new TextEncoder().encode("%PDF-"),
      }),
    });

    await expectRejected(
      resolver.resolve([paper(), paper()]),
      "selected more than once",
    );
  });

  it("rejects wrong parents, relative paths, and invalid PDF headers", async function () {
    const attachment = {
      id: 20,
      parentID: 99,
      attachmentContentType: "application/pdf",
      attachmentFilename: "paper.pdf",
      isAttachment: () => true,
      getFilePathAsync: async () => "paper.pdf",
    };
    const items = new Map<number, any>([
      [10, { id: 10, isRegularItem: () => true }],
      [20, attachment],
    ]);
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) => items.get(id) || null,
      inspectFile: async () => ({
        size: 10,
        type: "regular",
        header: new TextEncoder().encode("NOTPD"),
      }),
    });

    await expectRejected(resolver.resolve([paper()]), "no longer belongs");
    attachment.parentID = 10;
    attachment.attachmentContentType = "text/plain";
    attachment.attachmentFilename = "paper.txt";
    await expectRejected(resolver.resolve([paper()]), "not a PDF");
    attachment.attachmentContentType = "application/pdf";
    attachment.attachmentFilename = "paper.pdf";
    await expectRejected(resolver.resolve([paper()]), "absolute local path");
    attachment.getFilePathAsync = async () => "/paper.pdf";
    await expectRejected(resolver.resolve([paper()]), "not a valid PDF");
  });

  it("does not apply native-upload size limits to local paths", async function () {
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) =>
        id === 10
          ? ({ id: 10, isRegularItem: () => true } as any)
          : id === 20
            ? ({
                id: 20,
                parentID: 10,
                attachmentContentType: "application/pdf",
                attachmentFilename: "large.pdf",
                isAttachment: () => true,
                getFilePathAsync: async () => "/papers/large.pdf",
              } as any)
            : null,
      inspectFile: async () => ({
        size: 512 * 1024 * 1024,
        type: "regular",
        header: new TextEncoder().encode("%PDF-"),
      }),
    });

    const resources = await resolver.resolve([paper()]);

    assert.equal(resources[0].absolutePath, "/papers/large.pdf");
  });

  it("normalizes missing, empty, and unreadable file failures", async function () {
    const attachment = {
      id: 20,
      parentID: 10,
      attachmentContentType: "application/pdf",
      attachmentFilename: "paper.pdf",
      isAttachment: () => true,
      getFilePathAsync: async () => "/paper.pdf",
    };
    const getItemById = (id: number) =>
      id === 10
        ? ({ id: 10, isRegularItem: () => true } as any)
        : id === 20
          ? (attachment as any)
          : null;
    const missingResolver = createLocalPdfResourceResolver({
      getItemById,
      inspectFile: async () => {
        throw new Error("ENOENT: platform path detail");
      },
    });
    const emptyResolver = createLocalPdfResourceResolver({
      getItemById,
      inspectFile: async () => ({
        size: 0,
        type: "regular",
        header: new Uint8Array(),
      }),
    });

    await expectRejected(
      missingResolver.resolve([paper()]),
      "missing or unreadable",
    );
    await expectRejected(
      emptyResolver.resolve([paper()]),
      "missing or unreadable",
    );
  });

  it("does not expose a path from Zotero path-resolution failures", async function () {
    const resolver = createLocalPdfResourceResolver({
      getItemById: (id) =>
        id === 10
          ? ({ id: 10, isRegularItem: () => true } as any)
          : id === 20
            ? ({
                id: 20,
                parentID: 10,
                attachmentContentType: "application/pdf",
                attachmentFilename: "paper.pdf",
                isAttachment: () => true,
                getFilePathAsync: async () => {
                  throw new Error("ENOENT /private/secret/paper.pdf");
                },
              } as any)
            : null,
    });

    try {
      await resolver.resolve([paper()]);
      assert.fail("expected promise to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.include(message, "missing or unreadable");
      assert.notInclude(message, "/private/secret");
    }
  });
});
