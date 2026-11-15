import { appLogger } from "../core/logging";

/**
 * Bridge debug logger. Callers already gate these logs behind bridge debug prefs,
 * so this file only needs to emit them consistently in Zotero/browser contexts.
 */
const PREFIX = "[ClaudeBridge]";

function formatMessage(message: string, payload?: unknown): string {
  if (payload === undefined) {
    return `${PREFIX} ${message}`;
  }
  try {
    return `${PREFIX} ${message} | ${JSON.stringify(payload)}`;
  } catch {
    return `${PREFIX} ${message}`;
  }
}

export function dbg(message: string, payload?: unknown): void {
  if (!appLogger.isEnabled("debug")) return;
  const fullMessage = formatMessage(message, payload);
  appLogger.debug(fullMessage);
}

export function dbgError(message: string, error: unknown): void {
  const fullMessage = formatMessage(
    `ERROR: ${message}`,
    error instanceof Error ? { message: error.message } : error,
  );
  appLogger.warn(fullMessage);
}
