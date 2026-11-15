import { getMineruCheckpointProgress } from "../services/mineru/mineruCheckpoint";
import { getMineruAvailabilityForAttachmentId } from "../services/mineru/sync";
import { MineruCancelledError } from "../utils/mineruClient";

type ProcessingStatus = "idle" | "processing" | "failed" | "cached" | "partial";

interface ItemStatus {
  status: ProcessingStatus;
  updatedAt: number;
  errorMessage?: string;
}

const processingMap = new Map<number, ItemStatus>();
const listeners = new Set<() => void>();

type ActiveMineruTask = {
  promise: Promise<unknown>;
  controller: AbortController | null;
  progressListeners: Set<(stage: string) => void>;
  lastProgress: string;
};

const activeTasks = new Map<number, ActiveMineruTask>();

function createAbortController(): AbortController | null {
  const globalCtor = (
    globalThis as typeof globalThis & {
      AbortController?: new () => AbortController;
    }
  ).AbortController;
  if (globalCtor) return new globalCtor();

  if (typeof ztoolkit !== "undefined") {
    const toolkitCtor = ztoolkit.getGlobal("AbortController") as
      | (new () => AbortController)
      | undefined;
    if (toolkitCtor) return new toolkitCtor();
  }
  return null;
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}

export function setItemProcessing(attachmentId: number): void {
  processingMap.set(attachmentId, {
    status: "processing",
    updatedAt: Date.now(),
  });
  notifyListeners();
}

export function setItemCached(attachmentId: number): void {
  processingMap.set(attachmentId, {
    status: "cached",
    updatedAt: Date.now(),
  });
  notifyListeners();
}

export function setItemFailed(
  attachmentId: number,
  errorMessage?: string,
): void {
  const failed: ItemStatus = {
    status: "failed",
    updatedAt: Date.now(),
    errorMessage,
  };
  processingMap.set(attachmentId, failed);
  notifyListeners();
  void getMineruCheckpointProgress(attachmentId).then((progress) => {
    if (progress && processingMap.get(attachmentId) === failed) {
      processingMap.set(attachmentId, { ...failed, status: "partial" });
      notifyListeners();
    }
  });
}

export function clearItemStatus(attachmentId: number): void {
  processingMap.delete(attachmentId);
  notifyListeners();
}

export function clearItemCachedStatus(attachmentId: number): void {
  if (processingMap.get(attachmentId)?.status !== "cached") return;
  processingMap.delete(attachmentId);
  notifyListeners();
}

export function clearAllCachedStatuses(): void {
  let changed = false;
  for (const [attachmentId, status] of processingMap.entries()) {
    if (status.status === "cached") {
      processingMap.delete(attachmentId);
      changed = true;
    }
  }
  if (changed) notifyListeners();
}

export function getItemStatus(attachmentId: number): ItemStatus | undefined {
  return processingMap.get(attachmentId);
}

export async function runMineruTaskOnce<T>(
  attachmentId: number,
  task: (report: (stage: string) => void, signal?: AbortSignal) => Promise<T>,
  onProgress?: (stage: string) => void,
  subscriberSignal?: AbortSignal,
): Promise<{ joined: boolean; value: T }> {
  if (subscriberSignal?.aborted) throw new MineruCancelledError();

  const existing = activeTasks.get(attachmentId);
  if (existing) {
    if (onProgress) {
      existing.progressListeners.add(onProgress);
      if (existing.lastProgress) onProgress(existing.lastProgress);
    }
    try {
      return {
        joined: true,
        value: await waitForMineruTask(existing, subscriberSignal, false),
      };
    } finally {
      if (onProgress) existing.progressListeners.delete(onProgress);
    }
  }

  const progressListeners = new Set<(stage: string) => void>();
  if (onProgress) progressListeners.add(onProgress);
  const active: ActiveMineruTask = {
    promise: Promise.resolve(),
    controller: createAbortController(),
    progressListeners,
    lastProgress: "",
  };
  const report = (stage: string) => {
    active.lastProgress = stage;
    for (const listener of active.progressListeners) {
      try {
        listener(stage);
      } catch {
        /* ignore progress-listener failures */
      }
    }
  };
  active.promise = Promise.resolve()
    .then(() => {
      if (active.controller?.signal.aborted || subscriberSignal?.aborted) {
        throw new MineruCancelledError();
      }
      return task(report, active.controller?.signal);
    })
    .catch((error) => {
      // A stopped watcher may no longer own a UI callback to retire its dot.
      // Only this shared task's cancellation may clear its processing status;
      // a joined subscriber detaching must leave the other owner untouched.
      if (
        (error instanceof MineruCancelledError ||
          active.controller?.signal.aborted) &&
        activeTasks.get(attachmentId) === active &&
        processingMap.get(attachmentId)?.status === "processing"
      ) {
        clearItemStatus(attachmentId);
      }
      throw error;
    })
    .finally(() => {
      if (activeTasks.get(attachmentId) === active) {
        activeTasks.delete(attachmentId);
      }
    });
  activeTasks.set(attachmentId, active);

  try {
    return {
      joined: false,
      value: await waitForMineruTask(active, subscriberSignal, true),
    };
  } finally {
    if (onProgress) progressListeners.delete(onProgress);
  }
}

function waitForMineruTask<T>(
  active: ActiveMineruTask,
  subscriberSignal: AbortSignal | undefined,
  cancelSharedOnAbort: boolean,
): Promise<T> {
  if (!subscriberSignal) return active.promise as Promise<T>;

  if (subscriberSignal.aborted) {
    if (cancelSharedOnAbort) active.controller?.abort();
    return Promise.reject(new MineruCancelledError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      subscriberSignal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      if (cancelSharedOnAbort) {
        active.controller?.abort();
        return;
      }
      settled = true;
      cleanup();
      // Joined workflows only detach; the owner waits for durable writes.
      reject(new MineruCancelledError());
    };

    subscriberSignal.addEventListener("abort", onAbort, { once: true });
    active.promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (subscriberSignal.aborted) reject(new MineruCancelledError());
        else resolve(value as T);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** Cancel the active attachment operation, including tasks joined by another workflow. */
export function cancelMineruTask(attachmentId: number): boolean {
  const active = activeTasks.get(attachmentId);
  if (!active) return false;
  active.controller?.abort();
  return true;
}

export type MineruStatus =
  | "cached"
  | "processing"
  | "failed"
  | "idle"
  | "partial";

export async function getMineruStatus(
  attachmentId: number,
): Promise<MineruStatus> {
  let status = processingMap.get(attachmentId);
  if (status?.status === "processing") {
    return "processing";
  }

  const availability = await getMineruAvailabilityForAttachmentId(
    attachmentId,
    {
      validateSyncedPackage: false,
    },
  );
  if (processingMap.get(attachmentId) !== status) {
    return getMineruStatus(attachmentId);
  }
  if (availability.status !== "missing") {
    return "cached";
  }

  const progress = await getMineruCheckpointProgress(attachmentId);
  if (processingMap.get(attachmentId) !== status) {
    return getMineruStatus(attachmentId);
  }
  status = processingMap.get(attachmentId);
  if (progress) {
    if (processingMap.get(attachmentId)?.status === "processing")
      return "processing";
    if (status?.status !== "partial") {
      processingMap.set(attachmentId, {
        status: "partial",
        updatedAt: Date.now(),
      });
      notifyListeners();
    }
    return "partial";
  }
  if (status?.status === "partial") processingMap.delete(attachmentId);

  if (status?.status === "failed") {
    return "failed";
  }

  if (status?.status === "cached") {
    return "cached";
  }

  return "idle";
}

export function onProcessingStatusChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAllProcessingIds(): number[] {
  const result: number[] = [];
  for (const [id, status] of processingMap.entries()) {
    if (status.status === "processing") {
      result.push(id);
    }
  }
  return result;
}

export function getAllFailedIds(): number[] {
  const result: number[] = [];
  for (const [id, status] of processingMap.entries()) {
    if (status.status === "failed") {
      result.push(id);
    }
  }
  return result;
}

export function clearAllStatuses(): void {
  processingMap.clear();
  notifyListeners();
}

export async function cancelMineruTaskAndWait(
  attachmentId: number,
): Promise<void> {
  const active = activeTasks.get(attachmentId);
  if (!active) return;
  active.controller?.abort();
  try {
    await active.promise;
  } catch {
    /* The caller is removing the task's files. */
  }
}
