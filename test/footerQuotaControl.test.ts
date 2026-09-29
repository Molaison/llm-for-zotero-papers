import { assert } from "chai";
import {
  attachFooterQuotaControl,
  buildQuotaPresentation,
} from "../src/modules/contextPanel/footerQuotaControl";
import type { QuotaSnapshot } from "../src/providers/quota";

const snapshot = (amount: number): QuotaSnapshot => ({
  checkedAt: 1000,
  quota: {
    kind: "balance",
    scope: "account",
    balances: [{ currency: "USD", amount }],
  },
});

function fakeButton() {
  const attributes = new Map<string, string>();
  return {
    style: { display: "none" },
    textContent: "",
    title: "",
    ownerDocument: { defaultView: null },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
  } as unknown as HTMLButtonElement;
}

describe("footer provider quota", function () {
  it("labels monetary units and allowance scope without turning tiny balances into zero", function () {
    assert.equal(buildQuotaPresentation(snapshot(12.34))?.text, "$12.34");
    assert.equal(buildQuotaPresentation(snapshot(0))?.text, "$0.00");
    assert.equal(buildQuotaPresentation(snapshot(0.001))?.text, "<$0.01");
    const view = buildQuotaPresentation({
      checkedAt: 1000,
      quota: {
        kind: "balance",
        scope: "key",
        balances: [{ currency: "CNY", amount: 12 }],
      },
    })!;
    assert.equal(view.text, "CN¥12.00");
    assert.include(view.title, "API key allowance remaining");
    assert.include(view.title, "Last checked");
    assert.isNull(buildQuotaPresentation({ quota: null, checkedAt: 1000 }));
  });

  it("shows the most-used Codex window and explains both windows in the tooltip", function () {
    const view = buildQuotaPresentation({
      checkedAt: 1000,
      quota: {
        kind: "usage",
        windows: [
          { usedPercent: 20, durationMins: 300 },
          { usedPercent: 80, durationMins: 10080, resetsAt: 2000 },
        ],
      },
    })!;
    assert.equal(view.text, "80% used");
    assert.include(view.title, "5h: 20% used");
    assert.include(view.title, "7d: 80% used");
    assert.include(view.title, "Resets");
  });

  it("never paints a late result from the previous provider or after disposal", async function () {
    const button = fakeButton();
    let entry = {
      authMode: "api_key",
      apiBase: "https://api.deepseek.com",
      apiKey: "a",
    };
    const resolves: Array<(value: QuotaSnapshot) => void> = [];
    const control = attachFooterQuotaControl({
      button,
      getEntry: () => entry,
      read: () => new Promise((resolve) => resolves.push(resolve)),
    });
    const first = control.sync();
    entry = { ...entry, apiKey: "b" };
    const second = control.sync();
    resolves[1](snapshot(2));
    await second;
    assert.equal(button.textContent, "$2.00");
    resolves[0](snapshot(1));
    await first;
    assert.equal(button.textContent, "$2.00");
    entry = { ...entry, apiBase: "https://api.openai.com/v1" };
    await control.sync();
    assert.equal(button.style.display, "none");
    assert.equal(button.textContent, "");
    entry = { ...entry, apiBase: "https://api.deepseek.com" };
    const pending = control.sync();
    control.dispose();
    resolves[2](snapshot(3));
    await pending;
    assert.equal(button.style.display, "none");
  });

  it("removes the old value when a refresh is unavailable", async function () {
    const button = fakeButton();
    let available = true;
    const control = attachFooterQuotaControl({
      button,
      getEntry: () => ({
        authMode: "api_key",
        apiBase: "https://api.deepseek.com",
        apiKey: "a",
      }),
      read: async () =>
        available ? snapshot(5) : { quota: null, checkedAt: 2000 },
    });
    await control.sync();
    assert.equal(button.textContent, "$5.00");
    available = false;
    await control.sync(true);
    assert.equal(button.textContent, "");
    assert.equal(button.style.display, "none");
    control.dispose();
  });
});
