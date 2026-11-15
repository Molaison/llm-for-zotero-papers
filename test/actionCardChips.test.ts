import { assert } from "chai";
import {
  fakeDocument,
  collectFakeText,
  type FakeElement,
} from "./helpers/fakeDom";
import {
  renderTargetChip,
  renderTargetList,
  renderObjectChip,
  renderVerb,
  renderVerbWord,
  renderProcessChips,
  renderSkipRow,
  navigationTargetOf,
} from "../src/modules/contextPanel/agentTrace/actionCardChips";

const el = (node: HTMLElement) => node as unknown as FakeElement;

describe("action card chips", function () {
  it("renders a paper target as the composer's paper chip and makes it a link", function () {
    const chip = el(
      renderTargetChip(fakeDocument, {
        kind: "item",
        itemId: 11,
        label: "Smith, 2021",
        libraryID: 1,
        itemKey: "K11",
      }),
    );
    assert.include(chip.className, "llm-selected-context");
    assert.include(chip.className, "llm-paper-context-chip");
    assert.include(chip.className, "llm-agent-action-link");
    assert.equal(chip.getAttribute("role"), "link");
    assert.equal(chip.getAttribute("tabindex"), "0");
    const header = chip.findByClass("llm-paper-context-chip-header")!;
    assert.include(header.className, "llm-selected-context-header");
    assert.include(header.className, "llm-image-preview-header");
    assert.exists(header.findByClass("llm-paper-context-chip-label"));
    assert.exists(chip.findByClass("llm-context-icon-paper"));
    assert.equal(
      chip.findByClass("llm-paper-context-chip-text")!.textContent,
      "Smith, 2021",
    );
    assert.exists(chip.findByClass("llm-citation-icon"));
    assert.deepEqual(navigationTargetOf(chip as unknown as HTMLElement), {
      kind: "item",
      itemId: 11,
      label: "Smith, 2021",
      libraryID: 1,
      itemKey: "K11",
    });
  });

  it("folds targets past the second into a +N badge", function () {
    const list = el(
      renderTargetList(fakeDocument, [
        { kind: "item", itemId: 1, label: "A, 2001" },
        { kind: "item", itemId: 2, label: "B, 2002" },
        { kind: "item", itemId: 3, label: "C, 2003" },
        { kind: "item", itemId: 4, label: "D, 2004" },
      ]),
    );
    assert.include(list.className, "llm-agent-action-targets");
    assert.lengthOf(list.findAllByClass("llm-paper-context-chip"), 2);
    const badge = list.findByClass("llm-paper-picker-badge")!;
    assert.equal(badge.textContent, "+2");
    assert.equal(badge.getAttribute("title"), "C, 2003\nD, 2004");
  });

  it("renders each object kind with its own chip and icon", function () {
    assert.exists(
      el(
        renderObjectChip(fakeDocument, {
          kind: "collection",
          label: "Reviews",
          collectionId: 7,
        }),
      ).findByClass("llm-context-icon-collection"),
    );
    const removed = el(
      renderObjectChip(fakeDocument, {
        kind: "tag",
        label: "triage",
        removed: true,
      }),
    );
    assert.exists(removed.findByClass("llm-context-icon-tag"));
    assert.include(
      removed.findByClass("llm-tag-chip-label")!.className,
      "removed",
    );
    assert.notInclude(
      removed.className,
      "llm-agent-action-link",
      "a removed tag is not a link",
    );
    assert.isNull(navigationTargetOf(removed as unknown as HTMLElement));
    assert.exists(
      el(
        renderObjectChip(fakeDocument, {
          kind: "note",
          label: "Summary",
          noteId: 99,
        }),
      ).findByClass("llm-context-icon-note"),
    );
    const file = el(
      renderObjectChip(fakeDocument, {
        kind: "file",
        label: "a.md",
        path: "/x/a.md",
      }),
    );
    assert.exists(file.findByClass("llm-context-icon-file"));
    assert.include(
      file.findByClass("llm-other-ref-chip-title")!.className,
      "llm-agent-action-path",
    );
    const command = el(
      renderObjectChip(fakeDocument, { kind: "command", label: "pandoc" }),
    );
    assert.exists(command.findByClass("llm-context-icon-command"));
    assert.notInclude(command.className, "llm-agent-action-link");
    const trash = el(renderObjectChip(fakeDocument, { kind: "trash" }));
    assert.exists(trash.findByClass("llm-context-icon-trash"));
    assert.equal(
      trash.findByClass("llm-other-ref-chip-title")!.textContent,
      "Trash",
    );
    assert.equal(
      el(renderObjectChip(fakeDocument, { kind: "field", label: "DOI" }))
        .className,
      "llm-agent-hitl-badge",
    );
  });

  it("links the objects the reader can open, and only those", function () {
    const note = el(
      renderObjectChip(fakeDocument, {
        kind: "note",
        label: "Summary",
        noteId: 99,
        libraryID: 1,
        itemKey: "N99",
      }),
    );
    assert.include(note.className, "llm-agent-action-link");
    assert.equal(note.getAttribute("role"), "link");
    assert.equal(note.getAttribute("tabindex"), "0");
    assert.exists(note.findByClass("llm-citation-icon"));
    assert.deepEqual(navigationTargetOf(note as unknown as HTMLElement), {
      kind: "note",
      label: "Summary",
      noteId: 99,
      libraryID: 1,
      itemKey: "N99",
    });
    const file = el(
      renderObjectChip(fakeDocument, {
        kind: "file",
        label: "a.md",
        path: "/x/a.md",
      }),
    );
    assert.include(file.className, "llm-agent-action-link");
    assert.deepEqual(navigationTargetOf(file as unknown as HTMLElement), {
      kind: "file",
      label: "a.md",
      path: "/x/a.md",
    });
    const trash = el(renderObjectChip(fakeDocument, { kind: "trash" }));
    assert.include(trash.className, "llm-agent-action-link");
    assert.deepEqual(navigationTargetOf(trash as unknown as HTMLElement), {
      kind: "trash",
    });
    const unresolved = el(
      renderObjectChip(fakeDocument, { kind: "collection", label: "Reviews" }),
    );
    assert.notInclude(
      unresolved.className,
      "llm-agent-action-link",
      "a collection no receipt identified cannot be opened",
    );
    assert.isNull(navigationTargetOf(unresolved as unknown as HTMLElement));
    const unresolvedNote = el(
      renderObjectChip(fakeDocument, { kind: "note", label: "Note" }),
    );
    assert.notInclude(unresolvedNote.className, "llm-agent-action-link");
  });

  it("renders a verb glyph with the operation's word as tooltip, red when destructive", function () {
    const move = el(
      renderVerb(fakeDocument, { glyph: "→" }, "Moved to collection")!,
    );
    assert.include(move.className, "llm-agent-action-verb");
    assert.equal(move.findByClass("llm-context-glyph-icon")!.textContent, "→");
    assert.equal(move.getAttribute("title"), "Moved to collection");
    const word = move.findByClass("llm-agent-action-verb-word")!;
    assert.equal(word.textContent, "Moved to collection");
    assert.notInclude(
      word.className,
      "llm-agent-action-verb-word-inline",
      "the word is read out beside the glyph, not shown twice",
    );
    assert.include(
      el(
        renderVerb(
          fakeDocument,
          { glyph: "−", destructive: true },
          "Removed tags",
        )!,
      ).className,
      "llm-agent-action-verb-destructive",
    );
  });

  it("draws nothing for an operation with no glyph", function () {
    assert.isNull(
      renderVerb(fakeDocument, {}, "Created note"),
      "an empty verb node is a gap in the row with a tooltip nobody can reach",
    );
  });

  it("shows the operation's word where the effect has no object chip", function () {
    const shown = el(
      renderVerb(fakeDocument, { glyph: "→" }, "Moved to collection", true)!,
    ).findByClass("llm-agent-action-verb-word")!;
    assert.include(shown.className, "llm-agent-action-verb-word-inline");
    assert.equal(shown.textContent, "Moved to collection");
    const standalone = el(renderVerbWord(fakeDocument, "Created note", true));
    assert.include(standalone.className, "llm-agent-action-verb-word");
    assert.include(standalone.className, "llm-agent-action-verb-word-inline");
    assert.equal(standalone.textContent, "Created note");
  });

  it("renders process chips and the skip row", function () {
    const chips = el(
      renderProcessChips(fakeDocument, [
        "Verified",
        "Authorized by connected client",
      ]),
    );
    assert.include(chips.className, "llm-agent-process-chips");
    assert.deepEqual(
      chips
        .findAllByClass("llm-agent-process-chip-label")
        .map((c) => c.textContent),
      ["Verified", "Authorized by connected client"],
    );
    const skip = el(
      renderSkipRow(
        fakeDocument,
        [{ kind: "item", itemId: 3, label: "Okafor, 2019" }],
        "already in Reviews",
      ),
    );
    assert.include(skip.className, "llm-at-row-skip");
    assert.include(
      collectFakeText(skip),
      "Skipped Okafor, 2019 · already in Reviews",
    );
    const twoSkipped = el(
      renderSkipRow(
        fakeDocument,
        [
          { kind: "item", itemId: 3, label: "Okafor, 2019" },
          { kind: "item", itemId: 4, label: "Lee, 2020" },
        ],
        "already in Reviews",
      ),
    );
    assert.include(
      collectFakeText(twoSkipped),
      "Skipped Okafor, 2019, Lee, 2020 · already in Reviews",
    );
  });
});
