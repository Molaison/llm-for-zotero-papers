import { assert } from "chai";
import {
  getLocalParentPath,
  isUncPath,
  fileUrlToPath,
  pathToFileUrl,
  toFileUrl,
  isAbsoluteLocalPath,
} from "../src/utils/localPath";

describe("pathFileUrl", function () {
  it("should recognize supported absolute local path forms", function () {
    assert.isTrue(isAbsoluteLocalPath("/tmp/paper.pdf"));
    assert.isTrue(isAbsoluteLocalPath("C:\\Papers\\paper.pdf"));
    assert.isTrue(isAbsoluteLocalPath("\\\\server\\share\\paper.pdf"));
    assert.isFalse(isAbsoluteLocalPath("papers/paper.pdf"));
  });

  it("should convert POSIX path to file URL", function () {
    assert.equal(toFileUrl("/tmp/my file.md"), "file:///tmp/my%20file.md");
  });

  it("should convert Windows path to file URL", function () {
    assert.equal(
      toFileUrl("C:\\Users\\alice\\doc.txt"),
      "file:///C:/Users/alice/doc.txt",
    );
  });

  it("should return file URL unchanged", function () {
    assert.equal(toFileUrl("file:///tmp/demo.txt"), "file:///tmp/demo.txt");
  });

  it("should parse file URL back to path", function () {
    assert.equal(fileUrlToPath("file:///tmp/a%20b.txt"), "/tmp/a b.txt");
  });

  it("should encode reserved filename characters in POSIX file URLs", function () {
    assert.equal(toFileUrl("/tmp/a#b.txt"), "file:///tmp/a%23b.txt");
    assert.equal(toFileUrl("/tmp/a?b.txt"), "file:///tmp/a%3Fb.txt");
    assert.equal(fileUrlToPath("file:///tmp/a%23b.txt"), "/tmp/a#b.txt");
    assert.equal(fileUrlToPath("file:///tmp/a%3Fb.txt"), "/tmp/a?b.txt");
  });

  it("should parse Windows file URL back to native path", function () {
    assert.equal(
      fileUrlToPath("file:///C:/Users/alice/doc.txt"),
      "C:\\Users\\alice\\doc.txt",
    );
  });

  it("should round-trip UNC paths", function () {
    assert.equal(
      toFileUrl("\\\\server\\share\\folder\\doc.txt"),
      "file://server/share/folder/doc.txt",
    );
    assert.equal(
      fileUrlToPath("file://server/share/folder/doc.txt"),
      "\\\\server\\share\\folder\\doc.txt",
    );
  });

  it("treats leading double slashes as POSIX paths on POSIX hosts", function () {
    const originalZotero = globalThis.Zotero;
    (globalThis as typeof globalThis & { Zotero: { isWin: boolean } }).Zotero =
      {
        ...(originalZotero as unknown as Record<string, unknown>),
        isWin: false,
      } as typeof Zotero & { isWin: boolean };
    try {
      assert.isFalse(isUncPath("//server/share/paper.pdf"));
      assert.equal(
        getLocalParentPath("//server/share/paper.pdf"),
        "//server/share",
      );
      assert.equal(
        toFileUrl("//server/share/paper.pdf"),
        "file:////server/share/paper.pdf",
      );
      assert.equal(
        fileUrlToPath("file:////server/share/paper.pdf"),
        "//server/share/paper.pdf",
      );
      assert.isTrue(isUncPath("\\\\server\\share\\paper.pdf"));
    } finally {
      globalThis.Zotero = originalZotero;
    }
  });

  it("supports forward-slash UNC paths on Windows hosts", function () {
    const originalZotero = globalThis.Zotero;
    (globalThis as typeof globalThis & { Zotero: { isWin: boolean } }).Zotero =
      {
        ...(originalZotero as unknown as Record<string, unknown>),
        isWin: true,
      } as typeof Zotero & { isWin: boolean };
    try {
      assert.isTrue(isUncPath("//server/share/paper.pdf"));
      assert.equal(
        getLocalParentPath("//server/share/paper.pdf"),
        "\\\\server\\share",
      );
      assert.equal(
        toFileUrl("//server/share/paper.pdf"),
        "file://server/share/paper.pdf",
      );
      assert.equal(
        fileUrlToPath("file:////server/share/paper.pdf"),
        "\\\\server\\share\\paper.pdf",
      );
      assert.equal(
        fileUrlToPath(toFileUrl("//server/share/paper.pdf")),
        "\\\\server\\share\\paper.pdf",
      );
    } finally {
      globalThis.Zotero = originalZotero;
    }
  });

  it("should parse previously malformed UNC file URLs defensively", function () {
    const originalZotero = globalThis.Zotero;
    (globalThis as typeof globalThis & { Zotero: { isWin: boolean } }).Zotero =
      {
        ...(originalZotero as unknown as Record<string, unknown>),
        isWin: true,
      } as typeof Zotero & { isWin: boolean };
    try {
      assert.equal(
        fileUrlToPath("file:////server/share/folder/doc.txt"),
        "\\\\server\\share\\folder\\doc.txt",
      );
    } finally {
      globalThis.Zotero = originalZotero;
    }
  });

  it("should reject relative paths", function () {
    assert.isUndefined(toFileUrl("notes/demo.txt"));
  });

  it("pathToFileUrl should alias toFileUrl", function () {
    assert.strictEqual(pathToFileUrl, toFileUrl);
  });
});
