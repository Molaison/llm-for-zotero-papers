import { readFileSync } from "node:fs";
import { assert } from "chai";
import { describe, it } from "mocha";

// The in-place paper switch and the send-time context resolver live inside
// the setupHandlers closure. These pins keep two of their orderings visible;
// the workflow test paperSwitchInPlace drives the behavior in Zotero.

const source = readFileSync(
  "src/modules/contextPanel/setupHandlers.ts",
  "utf8",
);

function sliceBetween(start: string, end: string): string {
  const from = source.indexOf(start);
  assert.isAtLeast(from, 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.isAbove(to, from, `missing ${end} after ${start}`);
  return source.slice(from, to);
}

describe("in-place paper switch source pins", function () {
  it("shows the next paper's chips before the switch awaits anything", function () {
    const block = sliceBetween(
      "switchToPaperItem: (nextItem, nextBasePaperItem, rebuild) => {",
      "void runInPlacePaperSwitch(",
    );
    const restoreDraft = block.indexOf(
      "restoreDraftInputForCurrentConversation();",
    );
    const resetChips = block.indexOf("resetComposePreviewUI();");
    const flush = block.indexOf("flushPanelStateRefreshNow();");
    assert.isAtLeast(restoreDraft, 0);
    assert.isAbove(resetChips, restoreDraft);
    assert.isAbove(flush, resetChips);
    assert.notInclude(block, "await ");
  });

  it("a send resolves its own context source, not the shared snapshot after an await", function () {
    const resolver = sliceBetween(
      "const resolveAutoLoadedContextSourceAsync =",
      "const resolveAutoLoadedPaperContextAsync =",
    );
    const firstAwait = resolver.indexOf("await ");
    assert.isAtLeast(firstAwait, 0);
    assert.notInclude(
      resolver.slice(firstAwait),
      "return autoLoadedContextSourceSnapshot",
    );
    assert.include(resolver, "return contextSource;");
    const paperContext = sliceBetween(
      "const resolveAutoLoadedPaperContextAsync =",
      "const refreshAutoLoadedPaperContextForCurrentItem",
    );
    assert.include(paperContext, "await resolveAutoLoadedContextSourceAsync()");
  });

  it("a finished resolution never drops a newer resolution's shared promise", function () {
    const resolver = sliceBetween(
      "const resolveAutoLoadedContextSourceAsync =",
      "const resolveAutoLoadedPaperContextAsync =",
    );
    const cleanup = resolver.slice(resolver.indexOf("} finally {"));
    assert.match(
      cleanup,
      /if \(autoLoadedContextSourcePromise === pending\) \{\s+autoLoadedContextSourcePromise = null;/,
    );
  });
});
