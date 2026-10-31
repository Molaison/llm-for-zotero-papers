type MouseEventType = "mousemove" | "mousedown" | "mouseup";

type MouseEventWindow = {
  windowUtils?: {
    sendMouseEvent?: (
      type: string,
      x: number,
      y: number,
      button: number,
      clickCount: number,
      modifiers: number,
    ) => void;
    sendMouseEventToWindow?: (
      type: string,
      x: number,
      y: number,
      button: number,
      clickCount: number,
      modifiers: number,
    ) => void;
  };
};

/**
 * Drive a pointer through Gecko's native injector. DOM events cannot update
 * browser hit-test state, so they cannot establish the CSS `:hover` state that
 * the native sidebar tests verify.
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
  const utils = win.windowUtils;
  if (typeof utils?.sendMouseEvent === "function") {
    utils.sendMouseEvent(type, x, y, button, clickCount, modifiers);
    return;
  }
  if (typeof utils?.sendMouseEventToWindow === "function") {
    utils.sendMouseEventToWindow(type, x, y, button, clickCount, modifiers);
    return;
  }
  throw new Error(
    "This Gecko test window has no native mouse-event injector; DOM events cannot establish :hover",
  );
}
