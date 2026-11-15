/**
 * Shared error handling utilities.
 *
 * Replaces silent `catch {}` blocks with logged catches that preserve
 * debuggability while still allowing graceful degradation.
 */
import { appLogger } from "../core/logging";

/**
 * Log a caught error with a human-readable context string.
 * Use this in catch blocks instead of empty `catch {}`.
 */
export function logCatch(context: string, err: unknown): void {
  appLogger.warn(`LLM: ${context}`, err);
}
