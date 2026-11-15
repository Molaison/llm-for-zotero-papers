import { assert } from "chai";
import { refreshQuoteValidatedConversation } from "../src/modules/contextPanel/quoteValidation/chatRefreshBridge";
import { composePanelSurfaces } from "../src/modules/contextPanel/panelSurfaces";

const UNCOMPOSED = /adapter is not configured for this application surface/;

/** Stub arguments for the quote-validation refresh bridge. */
function refresh(): [
  Element,
  Zotero.Item,
  { rerenderAssistantMessages: ReadonlySet<never> },
] {
  return [
    {} as Element,
    { id: 4 } as Zotero.Item,
    { rerenderAssistantMessages: new Set<never>() },
  ];
}

/**
 * A composed bridge reaches the panel implementation, which is free to fail on
 * the stub inputs used here. Only the bridge's own "nothing is configured"
 * error means the surface was never composed.
 */
function captureFailure(call: () => void): string {
  try {
    call();
    return "";
  } catch (error) {
    return String(error);
  }
}

/**
 * The quote-validation refresher is composed here rather than with the
 * `src/services/**` host surfaces because installing it imports the chat
 * renderer, which workflow test bundles cannot carry.
 */
describe("panel surface composition", function () {
  it("composes the quote refresher at startup and clears it on shutdown", function () {
    const dispose = composePanelSurfaces();
    try {
      assert.notMatch(
        captureFailure(() => refreshQuoteValidatedConversation(...refresh())),
        UNCOMPOSED,
      );
    } finally {
      dispose();
    }

    assert.match(
      captureFailure(() => refreshQuoteValidatedConversation(...refresh())),
      UNCOMPOSED,
    );
  });
});
