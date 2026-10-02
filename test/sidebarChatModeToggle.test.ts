import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveSidebarChatModeTabAction,
  resolveSidebarChatModeToggleState,
  resolveSidebarModeChipArrow,
  resolveSidebarModeChipPick,
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

  it("routes the Stacked mode chip through the tabs' switch path", function () {
    const controller = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
      ),
      "utf8",
    );
    // One switch path: the tab clicks and the chip's picks both call it, so
    // the chip adds no mode logic of its own.
    assert.equal(
      controller.match(/const switchSidebarChatMode = async/g)?.length,
      1,
    );
    assert.match(
      controller,
      /installSidebarModeSwitch\(modeSwitch, \(requested\) => \{\s*void switchSidebarChatMode\(requested\)/,
    );
    assert.match(
      controller,
      /tabButton\.addEventListener\("click"[\s\S]*?void switchSidebarChatMode\(requested\)/,
    );
  });

  // The Stacked layout's mode chip picks a mode for the same switch path the
  // tabs use; these decide only which mode a gesture asks for.
  describe("resolveSidebarModeChipPick", function () {
    it("picks the clicked option while the switch is open", function () {
      assert.equal(
        resolveSidebarModeChipPick({
          expanded: true,
          clicked: "library",
          active: "paper",
        }),
        "library",
      );
      assert.equal(
        resolveSidebarModeChipPick({
          expanded: true,
          clicked: "paper",
          active: "library",
        }),
        "paper",
      );
    });

    it("makes no pick when the open switch's current mode is clicked", function () {
      for (const active of ["paper", "library"] as const) {
        assert.isNull(
          resolveSidebarModeChipPick({
            expanded: true,
            clicked: active,
            active,
          }),
        );
      }
    });

    it("toggles on a click with no hover, as on touch", function () {
      assert.equal(
        resolveSidebarModeChipPick({
          expanded: false,
          clicked: "paper",
          active: "paper",
        }),
        "library",
      );
      assert.equal(
        resolveSidebarModeChipPick({
          expanded: false,
          clicked: "library",
          active: "library",
        }),
        "paper",
      );
    });
  });

  describe("resolveSidebarModeChipArrow", function () {
    it("opens a closed switch with either arrow and picks nothing", function () {
      for (const key of ["ArrowDown", "ArrowUp"] as const) {
        assert.deepEqual(
          resolveSidebarModeChipArrow({
            key,
            expanded: false,
            rows: ["paper", "library"],
            active: "paper",
          }),
          { open: true, pick: null, focus: null },
        );
      }
    });

    it("picks the lower row with Down and the upper row with Up", function () {
      assert.deepEqual(
        resolveSidebarModeChipArrow({
          key: "ArrowDown",
          expanded: true,
          rows: ["paper", "library"],
          active: "paper",
        }),
        { open: false, pick: "library", focus: "library" },
      );
      assert.deepEqual(
        resolveSidebarModeChipArrow({
          key: "ArrowUp",
          expanded: true,
          rows: ["paper", "library"],
          active: "library",
        }),
        { open: false, pick: "paper", focus: "paper" },
      );
    });

    it("follows the rows as they opened, not the current mode", function () {
      // Opened in Library chat: Library is the upper row until it closes.
      assert.deepEqual(
        resolveSidebarModeChipArrow({
          key: "ArrowDown",
          expanded: true,
          rows: ["library", "paper"],
          active: "library",
        }),
        { open: false, pick: "paper", focus: "paper" },
      );
      assert.deepEqual(
        resolveSidebarModeChipArrow({
          key: "ArrowUp",
          expanded: true,
          rows: ["library", "paper"],
          active: "paper",
        }),
        { open: false, pick: "library", focus: "library" },
      );
    });

    it("only moves focus when the arrow points at the current mode", function () {
      assert.deepEqual(
        resolveSidebarModeChipArrow({
          key: "ArrowDown",
          expanded: true,
          rows: ["paper", "library"],
          active: "library",
        }),
        { open: false, pick: null, focus: "library" },
      );
    });
  });
});
