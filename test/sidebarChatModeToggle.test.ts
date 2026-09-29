import { assert } from "chai";
import {
  resolveSidebarChatModeTabAction,
  resolveSidebarChatModeToggleState,
} from "../src/modules/contextPanel/sidebarChatModeToggle";
import { resolveStandalonePaperTabLabel } from "../src/modules/contextPanel/standaloneTabLabel";

describe("sidebar chat mode toggle", function () {
  describe("resolveSidebarChatModeToggleState", function () {
    it("marks Paper chat active for a paper conversation", function () {
      assert.deepEqual(
        resolveSidebarChatModeToggleState({
          isGlobalMode: false,
          isNoteSession: false,
          isWebChat: false,
        }),
        {
          activeTab: "paper",
          paperTabLabel: "Paper chat",
          libraryTabLabel: "Library chat",
          disabled: false,
          showWebChatDot: false,
        },
      );
    });

    it("marks Library chat active for a library conversation", function () {
      const state = resolveSidebarChatModeToggleState({
        isGlobalMode: true,
        isNoteSession: false,
        isWebChat: false,
      });
      assert.equal(state.activeTab, "library");
      assert.equal(state.paperTabLabel, "Paper chat");
      assert.equal(state.libraryTabLabel, "Library chat");
      assert.isFalse(state.disabled);
    });

    it("labels the paper slot Note chat and keeps it active in a note session", function () {
      const state = resolveSidebarChatModeToggleState({
        isGlobalMode: false,
        isNoteSession: true,
        isWebChat: false,
      });
      assert.equal(state.activeTab, "paper");
      assert.equal(state.paperTabLabel, "Note chat");
      // A note navigates only within its own history; Library chat cannot open.
      assert.isTrue(state.disabled);
      assert.isFalse(state.showWebChatDot);
    });

    it("disables the toggle and shows the connection dot in webchat", function () {
      for (const isGlobalMode of [false, true]) {
        const state = resolveSidebarChatModeToggleState({
          isGlobalMode,
          isNoteSession: false,
          isWebChat: true,
        });
        assert.equal(state.activeTab, "paper", "webchat uses the paper slot");
        assert.equal(state.paperTabLabel, "Web chat");
        assert.isTrue(state.disabled);
        assert.isTrue(state.showWebChatDot);
      }
    });
  });

  it("uses the standalone window's tab wording", function () {
    for (const [flags, label] of [
      [{ isNoteSession: false, isWebChat: false }, "Paper chat"],
      [{ isNoteSession: true, isWebChat: false }, "Note chat"],
      [{ isNoteSession: false, isWebChat: true }, "Web chat"],
    ] as const) {
      const state = resolveSidebarChatModeToggleState({
        isGlobalMode: false,
        ...flags,
      });
      assert.equal(state.paperTabLabel, resolveStandalonePaperTabLabel(flags));
      assert.equal(state.paperTabLabel, label);
      assert.equal(state.libraryTabLabel, "Library chat");
    }
  });

  describe("resolveSidebarChatModeTabAction", function () {
    const paperState = resolveSidebarChatModeToggleState({
      isGlobalMode: false,
      isNoteSession: false,
      isWebChat: false,
    });
    const libraryState = resolveSidebarChatModeToggleState({
      isGlobalMode: true,
      isNoteSession: false,
      isWebChat: false,
    });

    it("ignores a click on the already-active tab", function () {
      assert.equal(
        resolveSidebarChatModeTabAction({
          requested: "paper",
          state: paperState,
          hasPaper: true,
        }),
        "noop",
      );
      assert.equal(
        resolveSidebarChatModeTabAction({
          requested: "library",
          state: libraryState,
          hasPaper: false,
        }),
        "noop",
      );
    });

    it("switches to Library chat from a paper conversation", function () {
      assert.equal(
        resolveSidebarChatModeTabAction({
          requested: "library",
          state: paperState,
          hasPaper: true,
        }),
        "switch-library",
      );
    });

    it("switches to Paper chat when a paper is available", function () {
      assert.equal(
        resolveSidebarChatModeTabAction({
          requested: "paper",
          state: libraryState,
          hasPaper: true,
        }),
        "switch-paper",
      );
    });

    it("reports a missing paper instead of switching", function () {
      assert.equal(
        resolveSidebarChatModeTabAction({
          requested: "paper",
          state: libraryState,
          hasPaper: false,
        }),
        "no-paper",
      );
    });

    it("ignores every click while the toggle is disabled", function () {
      for (const flags of [
        { isNoteSession: true, isWebChat: false },
        { isNoteSession: false, isWebChat: true },
      ]) {
        const state = resolveSidebarChatModeToggleState({
          isGlobalMode: false,
          ...flags,
        });
        for (const requested of ["paper", "library"] as const) {
          assert.equal(
            resolveSidebarChatModeTabAction({
              requested,
              state,
              hasPaper: true,
            }),
            "noop",
          );
        }
      }
    });
  });
});
