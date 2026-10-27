import { assert } from "chai";
import { FakeElement } from "./helpers/fakeDom";
import { attachComposeCaptureController } from "../src/modules/contextPanel/setupHandlers/controllers/composeCaptureController";

describe("add menu Escape ownership", () => {
  it("closes from trigger or menu and restores trigger focus without touching input Escape", () => {
    let focused: FakeElement | undefined, closes = 0;
    class Node extends FakeElement { focus() { focused = this; } }
    const body = new Node("div"), input = new Node("textarea"), trigger = new Node("button"), menu = new Node("div"), option = new Node("button");
    menu.append(option); body.append(input, trigger, menu);
    attachComposeCaptureController({
      body, inputBox: input, uploadBtn: trigger, slashMenu: menu,
      closeSlashMenu: () => { closes++; menu.style.display = "none"; trigger.setAttribute("aria-expanded", "false"); },
    } as unknown as Parameters<typeof attachComposeCaptureController>[0]);
    for (const origin of [trigger, menu]) {
      menu.style.display = "grid"; focused = undefined;
      const event = origin.dispatchFakeEvent("keydown", { key: "Escape", target: origin === menu ? option : trigger });
      assert.equal(menu.style.display, "none");
      assert.strictEqual(focused, trigger);
      assert.isTrue(event.defaultPrevented);
      assert.isTrue(event.propagationStopped);
    }
    assert.equal(closes, 2);
    menu.style.display = "grid";
    const inputEscape = input.dispatchFakeEvent("keydown", {key:"Escape"});
    assert.isFalse(inputEscape.defaultPrevented);
    assert.equal(closes, 2);
    const otherKey = trigger.dispatchFakeEvent("keydown", {key:"Enter"});
    assert.isFalse(otherKey.defaultPrevented);
    menu.style.display = "none";
    const closedEscape = trigger.dispatchFakeEvent("keydown", {key:"Escape"});
    assert.isFalse(closedEscape.defaultPrevented);
    assert.isFalse(closedEscape.propagationStopped);
    assert.equal(closes, 2);
  });
});
