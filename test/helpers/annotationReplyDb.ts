import {
  runAnnotationReplies,
  recoverAnnotationReplyBatch,
  loadAnnotationReplyBatches,
} from "../../src/services/pdf/annotationReplyService";
import {
  loadAnnotationReplyBatch,
  reserveAnnotationReplyBatch,
} from "../../src/utils/annotationReplyStore";
import type {
  AnnotationReplyBatch,
  AnnotationReplyTarget,
  AnnotationReplyPage,
} from "../../src/shared/types";
const runs = new Map<
  string,
  {
    finish: () => void;
    done: Promise<void>;
    accept: (raw: string, complete: boolean) => Promise<unknown>;
  }
>();
export async function prepareAnnotationReplyFixture(
  targets: AnnotationReplyTarget[],
  conversationKey: number,
  pages: AnnotationReplyPage[],
) {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let ready!: (batch: AnnotationReplyBatch) => void;
  let failed!: (error: unknown) => void;
  const result = new Promise<AnnotationReplyBatch>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const done = runAnnotationReplies(
    {
      selection: targets,
      conversationKey,
      preparedPages: pages,
      signal: new AbortController().signal,
      isActive: () => true,
      imageBudget: 9,
    },
    async (packet) => {
      runs.set(packet.batchId, { finish, done, accept: packet.acceptAnswer });
      ready(await loadAnnotationReplyBatch(packet.batchId));
      await pending;
    },
  );
  void done.catch(failed);
  return result;
}
export async function completeAnnotationReplyFixture(id: string, raw: string) {
  await runs.get(id)!.accept(raw, true);
  return loadAnnotationReplyBatch(id);
}
export async function finishAnnotationReplyFixture(id: string) {
  const run = runs.get(id);
  if (run) {
    run.finish();
    await run.done;
    runs.delete(id);
  }
}
export async function reparseAnnotationReplyFixture(id: string) {
  await finishAnnotationReplyFixture(id);
  return recoverAnnotationReplyBatch(id, "parse");
}
export async function reserveUnsentAnnotationReplyFixture(
  targets: AnnotationReplyTarget[],
  conversationKey: number,
  pages: AnnotationReplyPage[],
) {
  const batch: AnnotationReplyBatch = {
    id: crypto.randomUUID(),
    protocol: "zotero-annotation-replies/v1",
    createdAt: Date.now(),
    status: "inflight",
    stage: "reserved",
    owner: "previous-plugin/reserved",
    revision: 1,
    conversationKey,
    targets,
    pages,
  };
  await Zotero.DB.executeTransaction(() => reserveAnnotationReplyBatch(batch));
  return batch;
}
export async function settleUnsentAnnotationReplyFixture() {
  await loadAnnotationReplyBatches();
}
import { DatabaseSync } from "node:sqlite";
export function installAnnotationReplyTestDB() {
  const original = globalThis.Zotero;
  const db = new DatabaseSync(":memory:");
  const items = new Map<number, any>();
  let saves = 0;
  let tail = Promise.resolve();
  const queryAsync = async (sql: string, params: any[] = []) => {
    const stmt = db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };
  globalThis.Zotero = {
    Items: { get: (id: number) => items.get(id) },
    DB: {
      queryAsync,
      executeTransaction: (callback: () => Promise<any>) => {
        const task = tail.then(async () => {
          db.exec("BEGIN");
          try {
            const result = await callback();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        });
        tail = task.catch(() => undefined);
        return task;
      },
    },
  } as any;
  const attachment = (id: number, libraryID = 1, key = `PDF${id}`) => {
    const item = {
      id,
      libraryID,
      key,
      isAttachment: () => true,
      attachmentContentType: "application/pdf",
      getField: () => key,
      getAnnotations: () =>
        [...items.values()].filter((i) => i.parentID === id),
    };
    items.set(id, item);
    return item;
  };
  const annotation = (
    id: number,
    parentID: number,
    comment: string,
    key = `ANN${id}`,
  ) => {
    const item = {
      id,
      parentID,
      libraryID: items.get(parentID).libraryID,
      key,
      annotationComment: comment,
      annotationText: "source quote",
      annotationPosition: JSON.stringify({
        pageIndex: 0,
        rects: [[10, 20, 100, 40]],
      }),
      isAnnotation: () => true,
      isEditable: () => true,
      save: async () => {
        saves++;
      },
      deleted: false,
    };
    items.set(id, item);
    return item;
  };
  return {
    items,
    attachment,
    annotation,
    saves: () => saves,
    restore: async () => {
      for (const id of [...runs.keys()]) await finishAnnotationReplyFixture(id);
      globalThis.Zotero = original;
      db.close();
    },
  };
}
