import { assert } from "chai";
import { buildUI } from "../src/modules/contextPanel/buildUI";
import { attachFooterQuotaControl } from "../src/modules/contextPanel/footerQuotaControl";
import {
  parseApiQuota,
  resolveQuotaTarget,
  type QuotaSnapshot,
} from "../src/providers/quota";

describe("workflow: provider quota footer", function () {
  this.timeout(30000);

  it("fits beside context and permissions, refreshes on click, and hides unsupported providers", async function () {
    const doc = Zotero.getMainWindow().document;
    const root = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    root.style.cssText =
      "position:fixed;left:30px;top:30px;width:340px;height:550px;z-index:2147483647;background:var(--material-background)";
    doc.documentElement.appendChild(root);
    let control: ReturnType<typeof attachFooterQuotaControl> | undefined;
    try {
      buildUI(root, null);
      const panel = root.querySelector<HTMLElement>("#llm-main")!;
      // Keep the source-built footer in the viewport of the disposable window.
      // Its status, permission control and context gauge retain production CSS.
      panel.replaceChildren(root.querySelector(".llm-status-bar")!);
      root.style.height = "auto";
      const button = root.querySelector<HTMLButtonElement>(
        "#llm-provider-quota",
      )!;
      const permission = root.querySelector<HTMLElement>(
        "#llm-permission-control",
      )!;
      permission.style.display = "inline-flex";
      const permissionButton = root.querySelector<HTMLButtonElement>(
        "#llm-permission-toggle",
      )!;
      permissionButton.textContent = "Ask to edit";
      const status = root.querySelector<HTMLElement>("#llm-status")!;
      status.textContent =
        "Reading a paper with a long status message that wraps across multiple lines.";
      let entry = {
        authMode: "api_key",
        apiBase: "https://api.deepseek.com/v1",
        apiKey: "fixture-only",
      };
      let snapshot: QuotaSnapshot = {
        checkedAt: Date.now(),
        quota: {
          kind: "balance",
          scope: "account",
          balances: [{ currency: "USD", amount: 12.34 }],
        },
      };
      const refreshes: boolean[] = [];
      control = attachFooterQuotaControl({
        button,
        getTarget: () => resolveQuotaTarget(entry),
        read: async (_target, refresh) => {
          refreshes.push(refresh === true);
          return snapshot;
        },
      });
      await control.sync();
      assert.equal(button.textContent, "$12.34");
      assert.include(button.getAttribute("aria-label")!, "Account balance");

      // CNY labels are longer than USD; exercise both at narrow widths.
      for (const currency of ["USD", "CNY"]) {
        snapshot = {
          checkedAt: Date.now(),
          quota: {
            kind: "balance",
            scope: "account",
            balances: [{ currency, amount: 1234.56 }],
          },
        };
        await control.sync();
        for (const width of [280, 340, 550]) {
          for (const scale of [1, 1.25]) {
            root.style.width = `${width}px`;
            panel.style.setProperty("--llm-font-scale", String(scale));
            await Zotero.Promise.delay(50);
            const quotaRect = button.getBoundingClientRect();
            const gaugeRect = root
              .querySelector(".llm-context-usage-control")!
              .getBoundingClientRect();
            const permissionRect = permission.getBoundingClientRect();
            const statusRect = status.getBoundingClientRect();
            assert.isAbove(quotaRect.width, 0, "quota label is visible");
            assert.isAtLeast(
              quotaRect.left,
              gaugeRect.right - 1,
              "quota follows context without overlap",
            );
            assert.isAtLeast(
              gaugeRect.left,
              permissionRect.right - 1,
              "context follows permission control",
            );
            assert.isAtLeast(
              permissionRect.left,
              statusRect.right - 1,
              "status wraps before the controls",
            );
            assert.isAtMost(
              quotaRect.right,
              root.getBoundingClientRect().right + 1,
              "footer stays within the panel",
            );
            const hit = doc.elementFromPoint(
              quotaRect.x + quotaRect.width / 2,
              quotaRect.y + quotaRect.height / 2,
            );
            assert.isTrue(
              hit === button || button.contains(hit),
              "the quota control is reachable by a pointer",
            );
          }
        }
      }
      snapshot = {
        checkedAt: Date.now(),
        quota: {
          kind: "usage",
          windows: [
            { usedPercent: 42, durationMins: 300 },
            { usedPercent: 25, durationMins: 10080 },
          ],
        },
      };
      entry = { ...entry, authMode: "codex_app_server", apiBase: "" };
      await control.sync();
      assert.equal(button.textContent, "42% used");
      assert.include(button.title, "5h: 42% used");
      entry = {
        ...entry,
        authMode: "api_key",
        apiBase: "https://api.minimax.io/anthropic",
      };
      snapshot = {
        checkedAt: Date.now(),
        quota: parseApiQuota("minimax_global", {
          base_resp: { status_code: 0 },
          model_remains: [
            {
              model_name: "general",
              current_interval_remaining_percent: 80,
              current_weekly_remaining_percent: 35,
            },
          ],
        }),
      };
      await control.sync();
      assert.equal(button.textContent, "65% used");
      assert.include(button.title, "MiniMax Token Plan quota");
      entry = { ...entry, apiBase: "https://opencode.ai/zen/go/v1" };
      snapshot = {
        checkedAt: Date.now(),
        quota: parseApiQuota("opencode_go", {
          usage: {
            rolling: { status: "ok", percent: 10 },
            weekly: { status: "ok", percent: 75 },
            monthly: { status: "ok", percent: 40 },
          },
        }),
      };
      await control.sync();
      assert.equal(button.textContent, "75% used");
      assert.include(button.title, "OpenCode Go quota");
      assert.include(button.title, "Weekly: 75% used");
      assert.include(button.title, "Monthly: 40% used");
      if (Services.env.get("LLM_QUOTA_CAPTURE")) {
        root.style.width = "340px";
        panel.style.setProperty("--llm-font-scale", "1");
        await Zotero.Promise.delay(100);
        const rect = root
          .querySelector(".llm-status-bar")!
          .getBoundingClientRect();
        const canvas = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "canvas",
        ) as HTMLCanvasElement;
        canvas.width = Math.ceil(rect.width + 20);
        canvas.height = Math.ceil(rect.height + 20);
        (canvas.getContext("2d") as any).drawWindow(
          doc.defaultView,
          rect.x - 10,
          rect.y - 10,
          canvas.width,
          canvas.height,
          "white",
        );
        const bytes = Uint8Array.from(
          atob(canvas.toDataURL().split(",")[1]),
          (char) => char.charCodeAt(0),
        );
        await IOUtils.write("/private/tmp/llm-quota-footer.png", bytes);
      }
      button.click();
      await Zotero.Promise.delay(0);
      assert.isTrue(refreshes.at(-1));
      entry = {
        ...entry,
        authMode: "api_key",
        apiBase: "https://opencode.ai/zen/v1",
      };
      await control.sync();
      assert.equal(button.style.display, "none");
      assert.equal(button.textContent, "");
    } finally {
      control?.dispose();
      root.remove();
    }
  });
});
