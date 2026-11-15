import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { revealLocalPath } from "../src/utils/revealLocalPath";

const globalScope = globalThis as typeof globalThis & {
  Components?: unknown;
  Zotero?: unknown;
};

describe("revealLocalPath", function () {
  const originalComponents = globalScope.Components;
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Components = originalComponents;
    globalScope.Zotero = originalZotero;
  });

  it("uses nsIFile.reveal when available", function () {
    let initializedPath = "";
    let revealed = false;
    let zoteroFallbackCalled = false;
    globalScope.Components = {
      classes: {
        "@mozilla.org/file/local;1": {
          createInstance: () => ({
            initWithPath: (path: string) => {
              initializedPath = path;
            },
            reveal: () => {
              revealed = true;
            },
          }),
        },
      },
      interfaces: { nsIFile: {} },
    };
    globalScope.Zotero = {
      File: {
        reveal: () => {
          zoteroFallbackCalled = true;
        },
      },
      launchFile: () => {
        zoteroFallbackCalled = true;
      },
    };

    assert.equal(
      revealLocalPath("  /tmp/mineru-cache/11  "),
      "components-reveal",
    );
    assert.equal(initializedPath, "/tmp/mineru-cache/11");
    assert.isTrue(revealed);
    assert.isFalse(zoteroFallbackCalled);
  });

  it("falls back to Zotero.File.reveal", function () {
    let revealedPath = "";
    let launchFileCalled = false;
    globalScope.Components = {
      classes: {
        "@mozilla.org/file/local;1": {
          createInstance: () => {
            throw new Error("nsIFile unavailable");
          },
        },
      },
      interfaces: { nsIFile: {} },
    };
    globalScope.Zotero = {
      File: {
        reveal: (path: string) => {
          revealedPath = path;
        },
      },
      launchFile: () => {
        launchFileCalled = true;
      },
    };

    assert.equal(revealLocalPath("/tmp/mineru-cache/12"), "zotero-file-reveal");
    assert.equal(revealedPath, "/tmp/mineru-cache/12");
    assert.isFalse(launchFileCalled);
  });

  it("falls back to Zotero.launchFile", function () {
    let launchedPath = "";
    globalScope.Components = undefined;
    globalScope.Zotero = {
      launchFile: (path: string) => {
        launchedPath = path;
      },
    };

    assert.equal(revealLocalPath("/tmp/mineru-cache/13"), "zotero-launch-file");
    assert.equal(launchedPath, "/tmp/mineru-cache/13");
  });

  it("returns null when no reveal API is available", function () {
    globalScope.Components = undefined;
    globalScope.Zotero = {};

    assert.isNull(revealLocalPath("/tmp/mineru-cache/14"));
    assert.isNull(revealLocalPath("   "));
  });
});
