import { assert } from "chai";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";
import { getLibraryTextIndexDbPath } from "../../src/services/libraryTextIndex/db";

declare const Zotero: any;
declare const IOUtils: { exists: (path: string) => Promise<boolean> };

const REF = "llmforzotero";
const PREFIX = `#${REF}-library-text-index`;

function api(): WorkflowTestApi {
  return (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Zotero.Promise.delay(50);
  }
  assert.isTrue(await check(), message);
}

async function openCustomization(): Promise<Window> {
  const win = (Zotero.Utilities.Internal as any).openPreferences(
    `${REF}-preferences`,
  ) as Window;
  await waitFor(
    () =>
      Boolean(
        win.document?.querySelector(`${PREFIX}-status`)?.textContent?.trim(),
      ),
    20000,
    "the library index status renders",
  );
  (
    win.document.querySelector(
      '[data-pref-tab="customization"]',
    ) as HTMLButtonElement
  ).click();
  return win;
}

async function closePreferences(win: Window) {
  const components = (globalThis as any).Components;
  const mediator = components.classes[
    "@mozilla.org/appshell/window-mediator;1"
  ].getService(components.interfaces.nsIWindowMediator);
  win.close();
  await waitFor(
    () =>
      win.closed && !mediator.getEnumerator("zotero:pref").hasMoreElements(),
    10000,
    "preferences close",
  );
}

describe("workflow: library index settings", function () {
  this.timeout(180000);
  const created: number[] = [];
  const services = (globalThis as any).Services;
  const promptDescriptor = Object.getOwnPropertyDescriptor(services, "prompt");
  let win: Window | null = null;

  after(async function () {
    if (win && !win.closed) await closePreferences(win);
    if (promptDescriptor)
      Object.defineProperty(services, "prompt", promptDescriptor);
    await api().setLibraryTextIndexUserIdle(null);
    for (const id of created.reverse()) {
      try {
        await Zotero.Items.get(id)?.eraseTx();
      } catch {
        /* ignore */
      }
    }
  });

  it("renders beside Semantic Search in the same typography, clears the files, and rebuilds", async function () {
    Zotero.Prefs.set(
      `extensions.zotero.${REF}.libraryTextIndexEnabled`,
      true,
      true,
    );
    await api().setLibraryTextIndexUserIdle(false);
    const fixture = await api().createPaperWithPdfFixture({
      title: "Settings pane index paper",
      pdfTitle: "settings-pane.pdf",
      pages: ["The quorvex constant was 4.2 in the settings pane study."],
    });
    created.push(fixture.parentItemId);

    win = await openCustomization();
    const doc = win.document;
    const panel = doc.querySelector(
      `#${REF}-pref-panel-customization`,
    ) as HTMLElement;
    for (const suffix of [
      "-section",
      "-enabled",
      "-budget",
      "-status",
      "-rebuild",
      "-clear",
    ]) {
      assert.isOk(
        panel.querySelector(`${PREFIX}${suffix}`),
        `${suffix} sits inside the Customization panel`,
      );
    }
    assert.isNull(
      doc.querySelector(`${PREFIX}-vectors`),
      "embeddings are deferred: no control",
    );
    const section = doc.querySelector(`${PREFIX}-section`) as HTMLElement;
    const semanticSettings = doc.querySelector(
      `#${REF}-semantic-search-sub-settings`,
    ) as HTMLElement;
    assert.strictEqual(
      semanticSettings.nextElementSibling,
      section,
      "the block follows the Semantic Search block",
    );

    // Same label and hint typography as Semantic Search.
    const semanticToggle = doc.querySelector(
      `#${REF}-enable-semantic-search`,
    ) as HTMLElement;
    const indexToggle = doc.querySelector(`${PREFIX}-enabled`) as HTMLElement;
    const semanticLabel = win.getComputedStyle(
      semanticToggle.closest("label")!,
    );
    const indexLabel = win.getComputedStyle(indexToggle.closest("label")!);
    assert.equal(indexLabel.fontSize, semanticLabel.fontSize);
    assert.equal(indexLabel.fontWeight, semanticLabel.fontWeight);
    assert.equal(indexLabel.color, semanticLabel.color);
    const semanticHint = win.getComputedStyle(
      semanticToggle.closest("label")!.nextElementSibling!,
    );
    const indexHint = win.getComputedStyle(
      doc.querySelector(`${PREFIX}-hint`)!,
    );
    assert.equal(indexHint.fontSize, semanticHint.fontSize);
    assert.equal(indexHint.color, semanticHint.color);
    const label = doc.querySelector(`${PREFIX}-label`) as HTMLElement;
    assert.isAbove(
      label.getBoundingClientRect().width,
      0,
      "the block is visible",
    );

    // Budget: an invalid limit reverts to the stored value.
    const budget = doc.querySelector(`${PREFIX}-budget`) as HTMLInputElement;
    const storedBudget = budget.value;
    budget.value = "10";
    budget.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
    assert.equal(budget.value, storedBudget);

    // Clear, confirmed: the database file disappears, then the restarted index recreates it.
    const dbPath = getLibraryTextIndexDbPath();
    assert.isTrue(
      await IOUtils.exists(dbPath),
      "the index exists before Clear",
    );
    let confirms = 0;
    Object.defineProperty(services, "prompt", {
      configurable: true,
      value: {
        confirm: () => {
          confirms += 1;
          return true;
        },
      },
    });
    const seen: boolean[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const exists = await IOUtils.exists(dbPath);
        if (seen[seen.length - 1] !== exists) seen.push(exists);
      }
    })();
    const rebuild = doc.querySelector(`${PREFIX}-rebuild`) as HTMLButtonElement;
    const clear = doc.querySelector(`${PREFIX}-clear`) as HTMLButtonElement;
    const status = doc.querySelector(`${PREFIX}-status`) as HTMLElement;
    clear.click();
    assert.equal(confirms, 1, "Clear asked for confirmation");
    assert.isTrue(clear.disabled, "buttons are disabled while it runs");
    assert.isTrue(rebuild.disabled);
    assert.equal(status.textContent, "Working…");
    await waitFor(() => !clear.disabled, 30000, "Clear finishes");
    await waitFor(
      () => IOUtils.exists(dbPath),
      10000,
      "the restarted index recreates the database",
    );
    polling = false;
    await poller;
    assert.include(seen, false, "the database file was deleted by Clear");
    assert.equal(seen[seen.length - 1], true);
    if (promptDescriptor)
      Object.defineProperty(services, "prompt", promptDescriptor);

    // Rebuild: no confirmation; the status reports the refill and then settles.
    rebuild.click();
    assert.isTrue(rebuild.disabled);
    await waitFor(
      () => /^Building…/.test(status.textContent || ""),
      30000,
      `the status shows Building… (was "${status.textContent}")`,
    );
    assert.isTrue(
      await api().waitForLibraryTextIndexIdle(120000),
      "the rebuilt queue drains",
    );
    await waitFor(
      () =>
        !/^Building…/.test(status.textContent || "") &&
        /^Indexed \d+ of \d+ papers/.test(status.textContent || ""),
      15000,
      `the status settles (was "${status.textContent}")`,
    );
    const coverage = await api().libraryTextIndexCoverage([
      fixture.pdfAttachmentId,
    ]);
    assert.deepEqual(coverage.missing, [], "Rebuild re-filled the paper");
  });
});
