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
      const sourceHost = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      );
      const sourceRoot =
        sourceHost?.querySelector<HTMLElement>("#llm-main") || null;
      assert.isOk(sourceRoot, "the managed panel root is mounted");
      const testHost = doc.createElement("div");
      testHost.dataset.questionReadabilityFixture = "true";
      Object.assign(testHost.style, {
        position: "fixed",
        left: "-10000px",
        top: "0",
        width: "720px",
        height: "960px",
        minWidth: "0",
        minHeight: "0",
      });
      const layoutRoot = sourceRoot!.cloneNode(false) as HTMLElement;
      layoutRoot.removeAttribute("id");
      layoutRoot.removeAttribute("tabindex");
      layoutRoot.removeAttribute("data-handlers-attached");
      layoutRoot.removeAttribute("data-handlers-initialized");
      layoutRoot.dataset.questionReadabilityFixtureRoot = "true";
      const messages = doc.createElement("div");
      messages.className = "llm-messages";
      layoutRoot.appendChild(messages);
      testHost.appendChild(layoutRoot);
      (doc.body || doc.documentElement).appendChild(testHost);
      const nextFrame = () =>
        new Promise<void>((resolve) => {
          const view = doc.defaultView;
          if (view?.requestAnimationFrame)
            view.requestAnimationFrame(() => resolve());
          else setTimeout(resolve, 16);
        });
      const cardOf = () => {
        const card = messages.querySelector<HTMLElement>(
          `[data-request-id="${requestId}"]`,
        );
        assert.isOk(card, "the real pending question card is in the fixture");
        return card!;
      };
      const waitForStableCard = async (width: number, scale: number) => {
        const deadline = Date.now() + 3000;
        let previous: HTMLElement | null = null;
        let stableFrames = 0;
        const last = cardOf();
        while (Date.now() < deadline) {
          layoutRoot.style.setProperty("--llm-font-scale", `${scale}`);
          last.style.width = `${width}px`;
          last.style.maxWidth = "none";
          await nextFrame();
          const current = cardOf();
          current.style.width = `${width}px`;
          current.style.maxWidth = "none";
          if (current.isConnected) {
            const cardRect = current.getBoundingClientRect();
            const options = Array.from(
              current.querySelectorAll<HTMLElement>(
                ".llm-planning-question-option",
              ),
            ) as HTMLElement[];
            const measured =
              cardRect.width > 0 &&
              cardRect.height > 0 &&
              options.length > 0 &&
              options.every((option) => {
                const rect = option.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              });
            stableFrames =
              measured && previous === current
                ? stableFrames + 1
                : measured
                  ? 1
                  : 0;
            previous = current;
            if (stableFrames >= 2) return current;
          } else {
            previous = null;
            stableFrames = 0;
          }
        }
        const cards = messages.querySelectorAll("[data-request-id]").length;
        throw new Error(
          `Question card did not mount for two frames at ${width}px / ${scale}: ${JSON.stringify(
            {
              fixtureConnected: testHost.isConnected,
              rootConnected: layoutRoot.isConnected,
              cardConnected: last.isConnected,
              cardRect: last.getBoundingClientRect().toJSON(),
              cards,
            },
          )}`,
        );
      };
      try {
        const pending = api.renderPendingActionForPanel(panel.panelId, {
          requestId,
          action,
        });
        const card = sourceHost!.querySelector<HTMLElement>(
          `[data-request-id="${requestId}"]`,
        );
        assert.isOk(card, "the real pending card was rendered");
        messages.appendChild(card!);
        for (const [width, scale] of [
          [390, 1],
          [280, 1.5],
          [520, 1],
        ]) {
          const card = await waitForStableCard(width, scale);
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
        const submit = cardOf().querySelector<HTMLButtonElement>(
          ".llm-planning-question-continue",
        )!;
        assert.isTrue(submit.disabled);
        const choice = cardOf().querySelector<HTMLButtonElement>(
          ".llm-planning-question-option",
        )!;
        choice.click();
        const afterChoice = cardOf();
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
        const input = cardOf().querySelector<HTMLInputElement>(
          ".llm-planning-question-custom-input",
        )!;
        input.value = "Learning / Other";
        input.dispatchEvent(
          new (doc.defaultView as any).Event("input", { bubbles: true }),
        );
        const afterInput = cardOf();
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
        testHost.remove();
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
