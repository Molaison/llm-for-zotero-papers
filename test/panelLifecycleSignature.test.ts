import { assert } from "chai";
import {
  clearCompletedPanelLifecycleSignature,
  hasCompletedPanelLifecycleSignature,
  markCompletedPanelLifecycleSignature,
  type PanelLifecycleSignature,
} from "../src/modules/contextPanel/panelLifecycleSignature";

describe("panelLifecycleSignature", function () {
  const baseSignature = (): PanelLifecycleSignature => ({
    conversationKey: "1001",
    rawContextItemId: "2001",
    contextItemId: "2001",
    conversationSystem: "upstream",
    conversationKind: "paper",
    shortcutMode: "paper",
  });

  it("does not treat a signature as complete until it is marked complete", function () {
    const host = {};
    const signature = baseSignature();

    assert.isFalse(
      hasCompletedPanelLifecycleSignature(host, signature, {
        conversationLoaded: true,
      }),
    );

    markCompletedPanelLifecycleSignature(host, signature);

    assert.isTrue(
      hasCompletedPanelLifecycleSignature(host, signature, {
        conversationLoaded: true,
      }),
    );
  });

  it("does not skip when the conversation is not loaded", function () {
    const host = {};
    const signature = baseSignature();
    markCompletedPanelLifecycleSignature(host, signature);

    assert.isFalse(
      hasCompletedPanelLifecycleSignature(host, signature, {
        conversationLoaded: false,
      }),
    );
  });

  it("requires item, context, system, kind, and shortcut mode to match", function () {
    const changedFields: Array<keyof PanelLifecycleSignature> = [
      "conversationKey",
      "rawContextItemId",
      "contextItemId",
      "conversationSystem",
      "conversationKind",
      "shortcutMode",
    ];

    for (const field of changedFields) {
      const host = {};
      const signature = baseSignature();
      markCompletedPanelLifecycleSignature(host, signature);

      const changed = {
        ...signature,
        [field]: `${signature[field]}-changed`,
      };
      assert.isFalse(
        hasCompletedPanelLifecycleSignature(host, changed, {
          conversationLoaded: true,
        }),
        `expected ${field} change to require async setup`,
      );
    }
  });

  it("can clear a completed signature after a real panel rebuild", function () {
    const host = {};
    const signature = baseSignature();
    markCompletedPanelLifecycleSignature(host, signature);
    clearCompletedPanelLifecycleSignature(host);

    assert.isFalse(
      hasCompletedPanelLifecycleSignature(host, signature, {
        conversationLoaded: true,
      }),
    );
  });
});
