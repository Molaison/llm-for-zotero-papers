import { assert } from "chai";
import { getModelEntryById } from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: DeepSeek figure input defaults", function () {
  this.timeout(30000);

  it("enables figures for new models and preserves explicit Text only through model switches", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const prefix = "extensions.zotero.llmforzotero.";
    const scenarios = [
      {
        id: "official",
        model: "deepseek-v4-pro",
        apiBase: "https://api.deepseek.com/anthropic",
      },
      {
        id: "relay",
        model: "deepseek-reasoner",
        apiBase: "https://relay.example/anthropic",
      },
      {
        id: "future",
        model: "deepseek-future-model",
        apiBase: "http://localhost:11434/v1",
      },
      {
        id: "text",
        model: "deepseek-future-model",
        apiBase: "http://localhost:11434/v1",
        inputMode: "text_only",
      },
    ];
    const settings: Record<string, unknown> = {
      conversationSystem: "upstream",
      lastUsedModelEntryId: "deepseek-workflow-official",
      modelProviderGroupsMigrationVersion: 3,
      modelProviderGroups: JSON.stringify(
        scenarios.map((scenario) => ({
          id: `deepseek-group-${scenario.id}`,
          authMode: "api_key",
          apiBase: scenario.apiBase,
          apiKey: "workflow-test",
          providerProtocol: "anthropic_messages",
          models: [
            {
              id: `deepseek-workflow-${scenario.id}`,
              model: scenario.model,
              temperature: 0.3,
              outputTokenLimit: { mode: "auto" },
              ...(scenario.inputMode ? { inputMode: scenario.inputMode } : {}),
            },
          ],
        })),
      ),
    };
    const previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(prefix + key, true),
      ]),
    );
    let fixture: WorkflowTestFixture | undefined;
    await api.reset();
    try {
      for (const [key, value] of Object.entries(settings))
        Zotero.Prefs.set(prefix + key, value, true);
      fixture = await api.createPaperWithPdfFixture({
        title: "DeepSeek figure input",
        pdfTitle: "Figure fixture",
      });
      let panel = await api.renderPanelForItem(fixture.parentItemId);
      const assertFigureButton = async (disabled: boolean) => {
        const button =
          Zotero.getMainWindow().document.querySelector<HTMLButtonElement>(
            `[data-workflow-panel-id="${panel.panelId}"] #llm-screenshot`,
          );
        assert.isOk(button, "figure input control exists in the native panel");
        // Model selection schedules attachment-control updates for a frame.
        const deadline = Date.now() + 5000;
        while (button!.disabled !== disabled && Date.now() < deadline) {
          await Zotero.Promise.delay(25);
        }
        assert.equal(button!.disabled, disabled);
      };
      await assertFigureButton(false);
      for (const scenario of scenarios) {
        await api.selectPanelModelEntry(
          panel.panelId,
          `deepseek-workflow-${scenario.id}`,
        );
        assert.equal(
          Zotero.Prefs.get(prefix + "lastUsedModelEntryId", true),
          `deepseek-workflow-${scenario.id}`,
          "the model menu selects the requested configuration",
        );
        assert.equal(
          getModelEntryById(`deepseek-workflow-${scenario.id}`)?.advanced
            .inputMode,
          scenario.inputMode,
          "the saved model retains its input mode",
        );
        await assertFigureButton(scenario.inputMode === "text_only");
      }
      panel = await api.remountPanel(panel.panelId);
      await assertFigureButton(true);
      await api.selectPanelModelEntry(
        panel.panelId,
        "deepseek-workflow-future",
      );
      await assertFigureButton(false);
      panel = await api.remountPanel(panel.panelId);
      await assertFigureButton(false);
    } finally {
      if (fixture) await api.cleanupFixture(fixture);
      await api.reset();
      for (const [key, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, value, true);
      }
    }
  });
});
