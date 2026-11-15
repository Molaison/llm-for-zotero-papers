import { assert } from "chai";

const key = "extensions.zotero.llmforzotero.mineruMaxAutoPages";
const selector = "#llmforzotero-mineru-max-auto-pages-preset";

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.isTrue(condition(), "preferences finish opening or closing");
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
  );
}

async function openPreferences(): Promise<Window> {
  const win = (Zotero.Utilities.Internal as any).openPreferences(
    "llmforzotero-preferences",
  ) as Window;
  await waitFor(() => {
    const input = win.document.querySelector(
      "#llmforzotero-mineru-max-auto-pages",
    ) as HTMLInputElement | null;
    const expected = Number(Zotero.Prefs.get(key, true));
    const preset = win.document.querySelector(
      selector,
    ) as HTMLSelectElement | null;
    return (
      input?.value === String(expected || 100) &&
      preset?.value ===
        ([0, 100, 200, 500, 1000].includes(expected)
          ? String(expected)
          : "saved-custom")
    );
  });
  (
    win.document.querySelector('[data-pref-tab="mineru"]') as HTMLButtonElement
  ).click();
  const preset = win.document.querySelector(selector) as HTMLSelectElement;
  (preset.closest("details")!.querySelector("summary") as HTMLElement).click();
  await waitFor(() => preset.getBoundingClientRect().width > 0);
  return win;
}

function change(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
  type = "change",
) {
  element.value = value;
  const event = element.ownerDocument.createEvent("Event");
  event.initEvent(type, true, false);
  element.dispatchEvent(event);
}

function controls(win: Window) {
  return {
    preset: win.document.querySelector(selector) as HTMLSelectElement,
    input: win.document.querySelector(
      "#llmforzotero-mineru-max-auto-pages",
    ) as HTMLInputElement,
    unit: win.document.querySelector(
      "#llmforzotero-mineru-max-auto-pages-unit",
    ) as HTMLElement,
  };
}

describe("workflow: MinerU page-limit selection", function () {
  this.timeout(30000);
  it("preserves custom limits, saves every preset, and restores Unlimited after reopening", async function () {
    const previous = Zotero.Prefs.get(key, true);
    const enabledKey = "extensions.zotero.llmforzotero.mineruEnabled";
    const previousEnabled = Zotero.Prefs.get(enabledKey, true);
    let win: Window | undefined;
    try {
      Zotero.Prefs.set(enabledKey, true, true);
      Zotero.Prefs.clear(key, true);
      win = await openPreferences();
      assert.equal(
        controls(win).preset.value,
        "200",
        "fresh settings default to 200 pages",
      );
      assert.equal(Zotero.Prefs.get(key, true), 200);
      await closePreferences(win);
      Zotero.Prefs.set(key, 350, true);
      win = await openPreferences();
      let { preset, input, unit } = controls(win);
      assert.equal(preset.selectedOptions[0].textContent, "350");
      assert.isTrue(input.hidden);
      assert.isFalse(preset.hidden);
      const originalBounds = preset.getBoundingClientRect();
      assert.isAtMost(originalBounds.width, 88, "compact inline control");
      const originalUnitX = unit.getBoundingClientRect().x;
      const selectStyle = win.getComputedStyle(preset)!;
      assert.equal(selectStyle.textAlign, "left");
      change(preset, "custom");
      const editBounds = input.getBoundingClientRect();
      assert.closeTo(editBounds.x, originalBounds.x, 1);
      assert.closeTo(editBounds.width, originalBounds.width, 1);
      assert.closeTo(editBounds.height, originalBounds.height, 1);
      assert.closeTo(unit.getBoundingClientRect().x, originalUnitX, 1);
      const inputStyle = win.getComputedStyle(input)!;
      assert.equal(inputStyle.textAlign, selectStyle.textAlign);
      assert.equal(inputStyle.paddingLeft, selectStyle.paddingLeft);
      assert.equal(inputStyle.fontSize, selectStyle.fontSize);
      assert.isTrue(preset.hidden);
      assert.isFalse(input.hidden);
      change(input, "750", "input");
      assert.equal(Zotero.Prefs.get(key, true), 350, "typing is a draft");
      input.dispatchEvent(
        new (win as any).KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
      assert.equal(Zotero.Prefs.get(key, true), 750);
      assert.isTrue(input.hidden);
      assert.isFalse(preset.hidden);
      assert.equal(preset.selectedOptions[0].textContent, "750");
      await closePreferences(win);
      win = await openPreferences();
      ({ preset, input, unit } = controls(win));
      assert.equal(preset.selectedOptions[0].textContent, "750");
      assert.isTrue(input.hidden);
      for (const value of ["100", "200", "500", "1000", "0"]) {
        change(preset, value);
        assert.equal(Zotero.Prefs.get(key, true), Number(value));
        assert.isTrue(input.hidden);
        assert.isFalse(unit.hidden);
        assert.closeTo(unit.getBoundingClientRect().x, originalUnitX, 1);
      }
      change(preset, "custom");
      assert.isFalse(input.hidden);
      assert.isTrue(preset.hidden);
      change(input, "625", "input");
      change(input, "625", "blur");
      assert.equal(Zotero.Prefs.get(key, true), 625);
      assert.isTrue(input.hidden);
      assert.isFalse(preset.hidden);
      assert.equal(preset.selectedOptions[0].textContent, "625");
      change(preset, "custom");
      change(input, "999", "input");
      input.dispatchEvent(
        new (win as any).KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      assert.equal(Zotero.Prefs.get(key, true), 625);
      assert.isTrue(input.hidden);
      assert.isFalse(preset.hidden);
      change(preset, "0");
      await closePreferences(win);
      win = await openPreferences();
      ({ preset, input, unit } = controls(win));
      assert.equal(preset.value, "0");
      assert.isTrue(input.hidden);
      assert.isFalse(unit.hidden);
      assert.equal(Zotero.Prefs.get(key, true), 0);
    } finally {
      if (win && !win.closed) {
        await closePreferences(win);
      }
      if (previousEnabled === undefined) Zotero.Prefs.clear(enabledKey, true);
      else Zotero.Prefs.set(enabledKey, previousEnabled, true);
      if (previous === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, previous, true);
    }
  });
});
