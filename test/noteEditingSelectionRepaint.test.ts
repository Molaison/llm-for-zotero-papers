import { assert } from "chai";
import { refreshNoteEditingPanelsForNote } from "../src/modules/contextPanel";
import {
  activeContextPanelStateSync,
  clearAllState,
} from "../src/modules/contextPanel/state";

function fakeNotePanelBody(params: {
  noteId: number;
  conversationKey: number;
  connected?: boolean;
}): Element {
  const root = {
    dataset: {
      itemId: `${params.conversationKey}`,
      noteId: `${params.noteId}`,
    },
  };
  return {
    isConnected: params.connected !== false,
    querySelector: (selector: string) =>
      selector === "#llm-main" ? root : null,
  } as unknown as Element;
}

describe("note editing selection repaint", function () {
  afterEach(function () {
    clearAllState();
  });

  it("targets active note panels by note id instead of waiting on runtime conversation key matching", function () {
    const codexNoteKey = 8_000_001_000_003_703;
    const otherNoteKey = 8_000_001_000_003_704;
    const notePanel = fakeNotePanelBody({
      noteId: 3703,
      conversationKey: codexNoteKey,
    });
    const otherPanel = fakeNotePanelBody({
      noteId: 3704,
      conversationKey: otherNoteKey,
    });
    activeContextPanelStateSync.set(notePanel, () => undefined);
    activeContextPanelStateSync.set(otherPanel, () => undefined);

    assert.equal(refreshNoteEditingPanelsForNote(3703), 1);
  });
});
