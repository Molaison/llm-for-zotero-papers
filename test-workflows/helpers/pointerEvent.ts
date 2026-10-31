type MouseEventType = "mousemove" | "mousedown" | "mouseup";

type MouseEventWindow = {
  document: Document;
  MouseEvent: typeof MouseEvent;
  PointerEvent?: typeof PointerEvent;
  windowUtils?: {
    sendMouseEvent?: (
      type: string,
      x: number,
      y: number,
      button: number,
      clickCount: number,
      modifiers: number,
    ) => void;
  };
};

const previousTargets = new WeakMap<object, Element>();
const pressedTargets = new WeakMap<object, Element>();

function eventChain(target: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = target; node; node = node.parentElement) {
    chain.push(node);
  }
  return chain;
}

function dispatch(
  win: MouseEventWindow,
  type: string,
  target: Element,
  x: number,
  y: number,
  button: number,
  buttons: number,
  clickCount: number,
  pointer: boolean,
) {
  const EventCtor = pointer
    ? (win.PointerEvent ?? win.MouseEvent)
    : win.MouseEvent;
  const init: MouseEventInit & { pointerId?: number; pointerType?: string } = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win as unknown as Window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button,
    buttons,
    detail: clickCount,
    ...(pointer ? { pointerId: 1, pointerType: "mouse" } : {}),
  };
  target.dispatchEvent(new EventCtor(type, init));
}

/**
 * Drive a pointer with Zotero's native injector when it is available. Newer
 * Gecko test windows omit sendMouseEvent, so preserve the same browser event
 * sequence with DOM events instead of silently skipping the interaction.
 */
export function sendMouseEvent(
  win: MouseEventWindow,
  type: MouseEventType,
  x: number,
  y: number,
  button = 0,
  clickCount = 0,
  modifiers = 0,
): void {
  const nativeSend = win.windowUtils?.sendMouseEvent;
  if (typeof nativeSend === "function") {
    nativeSend.call(win.windowUtils, type, x, y, button, clickCount, modifiers);
    return;
  }

  const target = win.document.elementFromPoint(x, y);
  if (!target) {
    throw new Error(`No pointer target at (${x}, ${y})`);
  }
  const previous = previousTargets.get(win);
  const buttons = type === "mousedown" ? 1 : 0;

  if (type === "mousemove") {
    if (previous && previous !== target) {
      dispatch(win, "pointerout", previous, x, y, 0, 0, 0, true);
      dispatch(win, "mouseout", previous, x, y, 0, 0, 0, false);
      for (const node of eventChain(previous)) {
        dispatch(win, "pointerleave", node, x, y, 0, 0, 0, true);
        dispatch(win, "mouseleave", node, x, y, 0, 0, 0, false);
      }
    }
    if (!previous || previous !== target) {
      dispatch(win, "pointerover", target, x, y, 0, 0, 0, true);
      dispatch(win, "mouseover", target, x, y, 0, 0, 0, false);
      for (const node of eventChain(target)) {
        dispatch(win, "pointerenter", node, x, y, 0, 0, 0, true);
        dispatch(win, "mouseenter", node, x, y, 0, 0, 0, false);
      }
    }
    dispatch(win, "pointermove", target, x, y, 0, 0, 0, true);
    dispatch(win, "mousemove", target, x, y, 0, 0, 0, false);
    previousTargets.set(win, target);
    return;
  }

  if (type === "mousedown") {
    pressedTargets.set(win, target);
    dispatch(win, "pointerdown", target, x, y, button, 1, 1, true);
    dispatch(win, "mousedown", target, x, y, button, 1, 1, false);
    return;
  }

  dispatch(win, "pointerup", target, x, y, button, 0, clickCount, true);
  dispatch(win, "mouseup", target, x, y, button, 0, clickCount, false);
  if (clickCount > 0) {
    dispatch(win, "click", target, x, y, button, 0, clickCount, false);
  }
  pressedTargets.delete(win);
}
