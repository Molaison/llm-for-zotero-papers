type MouseEventType = "mousemove" | "mousedown" | "mouseup";

type MouseEventWindow = {
  MouseEvent: typeof MouseEvent & { readonly MOZ_SOURCE_MOUSE: number };
  navigator?: { userAgent?: string };
  synthesizeMouseEvent?: (
    type: string,
    x: number,
    y: number,
    eventData: {
      button: number;
      clickCount: number;
      modifiers: number;
      inputSource: number;
      identifier: number;
    },
    options: {
      isDOMEventSynthesized: boolean;
      isWidgetEventSynthesized: boolean;
      isAsyncEnabled: boolean;
    },
  ) => boolean;
  windowUtils?: {
    DEFAULT_MOUSE_POINTER_ID: number;
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

/**
 * Drive a pointer through Gecko's native injector. DOM events cannot update
 * browser hit-test state, so they cannot establish the CSS `:hover` state that
 * the native sidebar tests verify.
 *
 * Primary API:
 * https://searchfox.org/firefox-main/source/dom/webidl/Window.webidl#1270
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
  if (
    typeof win.synthesizeMouseEvent === "function" &&
    typeof utils?.DEFAULT_MOUSE_POINTER_ID === "number"
  ) {
    win.synthesizeMouseEvent(
      type,
      x,
      y,
      {
        button,
        clickCount,
        modifiers,
        inputSource: win.MouseEvent.MOZ_SOURCE_MOUSE,
        identifier: utils.DEFAULT_MOUSE_POINTER_ID,
      },
      {
        isDOMEventSynthesized: true,
        isWidgetEventSynthesized: false,
        isAsyncEnabled: false,
      },
    );
    return;
  }
  if (typeof utils?.sendMouseEvent === "function") {
    utils.sendMouseEvent.call(utils, type, x, y, button, clickCount, modifiers);
    return;
  }
  const diagnostics = {
    synthesizeMouseEvent: typeof win.synthesizeMouseEvent === "function",
    sendMouseEvent: typeof utils?.sendMouseEvent === "function",
    gecko: win.navigator?.userAgent ?? "unavailable",
  };
  throw new Error(
    `This Gecko test window has no native mouse-event injector; DOM events cannot establish :hover (${JSON.stringify(diagnostics)})`,
  );
}
