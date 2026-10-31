import { assert } from "chai";
import { buildNativeQuestionAction } from "../src/codexAppServer/nativeQuestions";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: question card readability", function () {
  this.timeout(30000);

  it("contains long choice text and keeps the active question visible after resizing", async function () {
    const requestId = "question-readability";
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Question card readability fixture",
      pages: ["Disposable question layout fixture."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const action = buildNativeQuestionAction([
        {
          id: "destination",
          question:
            'No collection named "Learning folder" exists. Which folder should "Representational Geometry" (currently in Geometry) be moved to?',
          options: [
            {
              label: "Learning (top-level)",
              description:
                "The top-level 'Learning' collection (15 papers, 31 incl. subfolders). Removes the paper from Geometry.",
            },
            {
              label: "Reinforcement_Learning",
              description:
                "The top-level 'Reinforcement_Learning' collection. Removes the paper from Geometry.",
            },
            {
              label: "Hebbian_Learning (child of Learning)",
              description:
                "The 'Hebbian_Learning' subfolder inside Learning. Removes the paper from Geometry.",
            },
          ],
        },
      ]);
      const pending = api.renderPendingActionForPanel(panel.panelId, {
        requestId,
        action,
      });
      const touchedRoots = new Map<HTMLElement, string>();
      const nextFrame = () =>
        new Promise<void>((resolve) => {
          const view = doc.defaultView;
          if (view?.requestAnimationFrame)
            view.requestAnimationFrame(() => resolve());
          else setTimeout(resolve, 16);
        });
      const mounted = () => {
        const host = doc.querySelector<HTMLElement>(
          `[data-workflow-panel-id="${panel.panelId}"]`,
        );
        const root = host?.querySelector<HTMLElement>(".llm-panel") || null;
        const messages =
          root?.querySelector<HTMLElement>(".llm-messages") || null;
        const card =
          host?.querySelector<HTMLElement>(
            `[data-request-id="${requestId}"]`,
          ) || null;
        if (messages && card && card.parentElement !== messages)
          messages.appendChild(card);
        return { host, root, messages, card };
      };
      const measure = (
        root: HTMLElement,
        card: HTMLElement,
        width: number,
        scale: number,
      ) => {
        if (!touchedRoots.has(root))
          touchedRoots.set(
            root,
            root.style.getPropertyValue("--llm-font-scale"),
          );
        card.style.width = `${width}px`;
        card.style.maxWidth = "none";
        root.style.setProperty("--llm-font-scale", `${scale}`);
        return { root, card };
      };
      const waitForMountedCard = async (
        width: number,
        scale: number,
      ): Promise<{ root: HTMLElement; card: HTMLElement }> => {
        const deadline = Date.now() + 3000;
        let previous: HTMLElement | null = null;
        let stableFrames = 0;
        let last = mounted();
        while (Date.now() < deadline) {
          last = mounted();
          if (last.root && last.card)
            measure(last.root, last.card, width, scale);
          await nextFrame();
          const current = mounted();
          if (current.root && current.card) {
            measure(current.root, current.card, width, scale);
            const cardRect = current.card.getBoundingClientRect();
            const options = Array.from(
              current.card.querySelectorAll<HTMLElement>(
                ".llm-planning-question-option",
              ),
            ) as HTMLElement[];
            const measured =
              current.card.isConnected &&
              cardRect.width > 0 &&
              cardRect.height > 0 &&
              options.length > 0 &&
              options.every((option) => {
                const rect = option.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              });
            stableFrames =
              measured && previous === current.card
                ? stableFrames + 1
                : measured
                  ? 1
                  : 0;
            previous = current.card;
            if (stableFrames >= 2)
              return { root: current.root, card: current.card };
          } else {
            previous = null;
            stableFrames = 0;
          }
        }
        const cards = last.host?.querySelectorAll("[data-request-id]").length;
        throw new Error(
          `Question card did not mount for two frames at ${width}px / ${scale}: ${JSON.stringify(
            {
              hostConnected: last.host?.isConnected,
              rootConnected: last.root?.isConnected,
              cardConnected: last.card?.isConnected,
              cardRect: last.card?.getBoundingClientRect().toJSON(),
              cards,
            },
          )}`,
        );
      };
      try {
        for (const [width, scale] of [
          [390, 1],
          [280, 1.5],
          [520, 1],
        ]) {
          const { card } = await waitForMountedCard(width, scale);
          for (const option of Array.from(
            card.querySelectorAll<HTMLElement>(".llm-planning-question-option"),
          ) as HTMLElement[]) {
            const bounds = option.getBoundingClientRect();
            const copy = option
              .querySelector<HTMLElement>(".llm-planning-question-option-copy")!
              .getBoundingClientRect();
            assert.isAtLeast(
              copy.top,
              bounds.top + 4,
              `choice top padding at ${width}px: ${JSON.stringify({ bounds: bounds.toJSON(), copy: copy.toJSON(), height: doc.defaultView!.getComputedStyle(option)!.height })}`,
            );
            assert.isAtMost(
              copy.bottom,
              bounds.bottom - 4,
              `choice bottom padding at ${width}px`,
            );
            assert.isAtMost(
              copy.right,
              bounds.right - 4,
              `choice horizontal containment at ${width}px`,
            );
            const markerStyle = doc.defaultView!.getComputedStyle(
              option.querySelector(".llm-planning-question-option-marker")!,
            )!;
            assert.isAbove(
              parseFloat(markerStyle.borderTopWidth),
              0,
              "choice indicator must remain visible",
            );
          }
          const viewport = card
            .querySelector<HTMLElement>(".llm-planning-question-viewport")!
            .getBoundingClientRect();
          const active = card
            .querySelector<HTMLElement>(
              '.llm-planning-question-panel[aria-hidden="false"]',
            )!
            .getBoundingClientRect();
          assert.closeTo(
            active.top,
            viewport.top,
            1,
            "question starts at the visible viewport",
          );
          assert.isAtMost(
            active.bottom,
            viewport.bottom + 1,
            `question is not clipped after resize to ${width}px`,
          );
          assert.equal(
            doc.defaultView!.getComputedStyle(
              card.querySelector(".llm-planning-question-prompt")!,
            )!.textTransform,
            "none",
          );
        }
        const currentCard = () => {
          const state = mounted();
          assert.isOk(state.root, "the managed question root is mounted");
          assert.isOk(state.card, "the managed question card is mounted");
          return state.card!;
        };
        const submit = currentCard().querySelector<HTMLButtonElement>(
          ".llm-planning-question-continue",
        )!;
        assert.isTrue(submit.disabled);
        const choice = currentCard().querySelector<HTMLButtonElement>(
          ".llm-planning-question-option",
        )!;
        choice.click();
        const afterChoice = currentCard();
        assert.equal(
          afterChoice
            .querySelector<HTMLButtonElement>(".llm-planning-question-option")!
            .getAttribute("aria-checked"),
          "true",
        );
        assert.isFalse(
          afterChoice.querySelector<HTMLButtonElement>(
            ".llm-planning-question-continue",
          )!.disabled,
        );
        const input = currentCard().querySelector<HTMLInputElement>(
          ".llm-planning-question-custom-input",
        )!;
        input.value = "Learning / Other";
        input.dispatchEvent(
          new (doc.defaultView as any).Event("input", { bubbles: true }),
        );
        const afterInput = currentCard();
        assert.equal(
          afterInput
            .querySelector<HTMLButtonElement>(".llm-planning-question-option")!
            .getAttribute("aria-checked"),
          "false",
        );
        afterInput
          .querySelector<HTMLButtonElement>(".llm-planning-question-continue")!
          .click();
        const resolution = await pending;
        assert.isTrue(resolution.approved);
        assert.deepEqual(resolution.data, {
          destination: { kind: "custom", text: "Learning / Other" },
        });
      } finally {
        for (const [root, oldScale] of touchedRoots) {
          if (oldScale) root.style.setProperty("--llm-font-scale", oldScale);
          else root.style.removeProperty("--llm-font-scale");
        }
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
