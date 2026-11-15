import { appLogger } from "../core/logging";

type QuitPhase = {
  addBlocker?: (name: string, blocker: () => Promise<void>) => void;
  removeBlocker?: (blocker: () => Promise<void>) => void;
};

function resolveQuitPhase(): QuitPhase | null {
  try {
    const chromeUtils = (globalThis as { ChromeUtils?: any }).ChromeUtils;
    const module = chromeUtils?.importESModule?.(
      "resource://gre/modules/AsyncShutdown.sys.mjs",
    );
    return module?.AsyncShutdown?.profileBeforeChange || null;
  } catch (error) {
    appLogger.debug("LLM: AsyncShutdown unavailable", error);
    return null;
  }
}

/**
 * Runs `task` when Zotero quits. bootstrap.js skips the plugin's onShutdown on
 * APP_SHUTDOWN, so this is the only cleanup a quit gets. Zotero's exit waits
 * for every open Sqlite connection, so anything holding one must close it
 * here. Returns an unregister for an orderly stop (disable, update, reload).
 */
export function registerAppQuitBlocker(
  name: string,
  task: () => Promise<void>,
): () => void {
  const phase = resolveQuitPhase();
  if (!phase?.addBlocker) return () => undefined;
  const blocker = async () => {
    try {
      await task();
    } catch (error) {
      appLogger.debug(`LLM: quit cleanup failed: ${name}`, error);
    }
  };
  try {
    phase.addBlocker(name, blocker);
  } catch (error) {
    // Too late in shutdown to add a blocker; nothing will wait for it.
    appLogger.debug(`LLM: could not register quit cleanup: ${name}`, error);
    return () => undefined;
  }
  return () => {
    try {
      phase.removeBlocker?.(blocker);
    } catch {
      /* already removed or shutdown in progress */
    }
  };
}
