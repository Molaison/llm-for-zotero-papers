/**
 * The single list of keys the panel composer's keydown handler binds. The
 * handler lives in `setupHandlers.ts` (`inputBox.addEventListener("keydown")`)
 * and owns the behaviour: Enter sends, ArrowUp recalls, Escape and Backspace
 * edit the command row, Tab and the arrows drive the pickers.
 *
 * The panel ownership fence (`panelHostOwnership.ts`) reads this list to decide
 * which key combinations it may hand to the application while it is refusing a
 * panel's input: an accelerator is exempt only when the key is not one of
 * these, so a panel that no longer owns its conversation can never send, recall
 * or persist into it by holding Cmd or Ctrl (Cmd+Enter is a send — the
 * composer's Enter branch has no modifier exclusion).
 *
 * Adding a binding to that handler means adding its key here; the guard cases
 * in `test/panelHostOwnership.test.ts` read the handler's source and fail when
 * the two drift apart.
 */
export const COMPOSER_BOUND_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);
