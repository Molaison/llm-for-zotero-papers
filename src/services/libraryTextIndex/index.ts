/**
 * Facade for the library text index: lifecycle wiring now, search in Task 8.
 * Callers load this module lazily (hooks.ts), so its own imports are static:
 * one module instance per dependency, whichever loader resolves it.
 */
import { appLogger } from "../../core/logging";
import { onPdfContextLoaded } from "../paperContent/contextCache";
import { zoteroChangeDispatcher } from "../zoteroChangeDispatcher";
import { INDEX_USER_IDLE_SECONDS } from "./constants";
import { closeLibraryTextIndexDb } from "./db";
import { libraryTextIndexScheduler, type SchedulerEnv } from "./scheduler";
import { createUserIdleTracker, type UserIdleTracker } from "./userIdle";

export {
  libraryTextIndexScheduler,
  beginRetrievalActivity,
  isLibraryTextIndexEnabled,
  getLibraryTextIndexBudgetBytes,
} from "./scheduler";
export type { LibraryTextIndexStatus } from "./scheduler";

let unsubscribeChanges: (() => void) | null = null;
let unsubscribeContexts: (() => void) | null = null;
let idleTracker: UserIdleTracker | null = null;
let restoreEnv: Partial<SchedulerEnv> | null = null;

/**
 * Starts the background fill. Deferred startup work: it never opens a
 * transaction on or queries `Zotero.DB` (#485); all index SQL goes through the
 * separate index connection.
 */
export async function startLibraryTextIndex(
  envOverride: Partial<SchedulerEnv> = {},
): Promise<void> {
  if (idleTracker) await stopLibraryTextIndex();
  const scheduler = libraryTextIndexScheduler as unknown as {
    env: SchedulerEnv;
  };
  const tracker = createUserIdleTracker(INDEX_USER_IDLE_SECONDS);
  idleTracker = tracker;
  const replaced: Partial<SchedulerEnv> = {
    isUserIdle: () => tracker.isIdle(),
    ...envOverride,
  };
  restoreEnv = Object.fromEntries(
    Object.keys(replaced).map((key) => [
      key,
      scheduler.env[key as keyof SchedulerEnv],
    ]),
  ) as Partial<SchedulerEnv>;
  Object.assign(scheduler.env, replaced);
  tracker.onChange((idle) => libraryTextIndexScheduler.onUserIdleChange(idle));
  // Ordered, but never holds up the dispatcher's other listeners.
  let changeTail: Promise<void> = Promise.resolve();
  unsubscribeChanges = zoteroChangeDispatcher.subscribe(
    "library-text-index",
    (change) => {
      changeTail = changeTail
        .then(() => libraryTextIndexScheduler.handleChange(change))
        .catch((error) =>
          appLogger.debug("LLM index: change handling failed", error),
        );
    },
  );
  unsubscribeContexts = onPdfContextLoaded((itemId) =>
    libraryTextIndexScheduler.handleContextLoaded(itemId),
  );
  libraryTextIndexScheduler.start();
  await libraryTextIndexScheduler.reconcileAll();
}

export async function stopLibraryTextIndex(): Promise<void> {
  unsubscribeChanges?.();
  unsubscribeChanges = null;
  unsubscribeContexts?.();
  unsubscribeContexts = null;
  idleTracker?.dispose();
  idleTracker = null;
  await libraryTextIndexScheduler.stop();
  if (restoreEnv) {
    Object.assign(
      (libraryTextIndexScheduler as unknown as { env: SchedulerEnv }).env,
      restoreEnv,
    );
    restoreEnv = null;
  }
  // Awaits an open still in flight so its handle cannot leak past shutdown.
  await closeLibraryTextIndexDb();
}
