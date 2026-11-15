/**
 * A real SQLite store of the dormant plan tables behind a fake `Zotero`, for
 * tests that hold a stored plan execution the way an old profile does.
 *
 * The rows are proxied because Zotero's rows THROW when code reads a column
 * the SELECT did not name, where a plain node:sqlite row would quietly answer
 * `undefined`.
 */

import { DatabaseSync } from "node:sqlite";
import {
  PLAN_EXECUTION_TASKS_TABLE,
  PLAN_EXECUTIONS_TABLE,
  initDormantPlanTables,
} from "../../src/agent/store/dormantPlanTables";

/** A stored plan execution task, as plan mode wrote it. */
type StoredPlanTask = Record<string, unknown> & {
  taskId: string;
  executionId: string;
  planStepId: string;
  parentTaskId?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

/** A stored plan execution ledger, as plan mode wrote it. */
export type StoredPlanExecutionLedger = Record<string, unknown> & {
  executionId: string;
  planId: string;
  revision: number;
  conversationKey: number;
  status: string;
  activeTaskId?: string;
  tasks: StoredPlanTask[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

const STEPS = [
  "Read the selected paper",
  "Explain the agreed concept",
  "Publish the explanation",
];

/**
 * A three-step execution stopped at its second step with `status`: the first
 * step is completed and the third has not started.
 */
export function storedPlanExecution(
  status: "interrupted" | "waiting_for_user",
  conversationKey: number,
): StoredPlanExecutionLedger {
  const executionId = `execution-${status}-${conversationKey}`;
  const task = (index: number): StoredPlanTask => {
    const taskStatus =
      index === 0 ? "completed" : index === 1 ? status : "pending";
    return {
      version: 2,
      taskId: `${executionId}:task-${index + 1}`,
      executionId,
      planStepId: `step-${index + 1}`,
      kind: "required_step",
      content: STEPS[index],
      activeForm: STEPS[index],
      acceptanceCriteria: [
        {
          criterionId: `criterion-${index + 1}`,
          description: `${STEPS[index]} is done`,
          verifier: "bounded_reasoning",
        },
      ],
      expectedEffect: "reasoning",
      obligationIds: [],
      status: taskStatus,
      attemptCount: taskStatus === "pending" ? 0 : 1,
      evidenceIds: [],
      failureReasons: [],
      createdAt: 1,
      updatedAt: 1,
    };
  };
  return {
    version: 2,
    executionId,
    planId: `plan-${conversationKey}`,
    revision: 1,
    planDigest: "sha256:plan",
    conversationKey,
    attempt: 1,
    provider: "original",
    grant: {
      version: 1,
      planId: `plan-${conversationKey}`,
      revision: 1,
      planDigest: "sha256:plan",
      conversationKey,
      conversationGeneration: 1,
      authority: "user",
      approvedAt: 1,
    },
    status,
    activeTaskId:
      status === "waiting_for_user" ? `${executionId}:task-2` : undefined,
    tasks: STEPS.map((_, index) => task(index)),
    createdAt: 1,
    updatedAt: 2,
  };
}

/**
 * Write `ledger` into the dormant plan tables the way plan mode saved an
 * execution: its row, then one row per task in order.
 */
export async function saveStoredPlanExecution(
  ledger: StoredPlanExecutionLedger,
): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `INSERT OR REPLACE INTO ${PLAN_EXECUTIONS_TABLE}
        (execution_id, plan_id, revision, conversation_key, status,
         active_task_id, payload_json, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ledger.executionId,
        ledger.planId,
        ledger.revision,
        ledger.conversationKey,
        ledger.status,
        ledger.activeTaskId || null,
        JSON.stringify(ledger),
        ledger.createdAt,
        ledger.updatedAt,
        ledger.completedAt || null,
      ],
    );
    for (let index = 0; index < ledger.tasks.length; index += 1) {
      const task = ledger.tasks[index];
      await Zotero.DB.queryAsync(
        `INSERT OR REPLACE INTO ${PLAN_EXECUTION_TASKS_TABLE}
          (task_id, execution_id, plan_step_id, parent_task_id, task_order,
           status, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.taskId,
          task.executionId,
          task.planStepId,
          task.parentTaskId || null,
          index,
          task.status,
          JSON.stringify(task),
          task.createdAt,
          task.updatedAt,
        ],
      );
    }
  });
}

function toZoteroRow(row: Record<string, unknown>) {
  return new Proxy(row, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        throw new Error(`Column '${prop}' not present in this row`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Install the store and return the function that closes it and puts the
 * previous `Zotero` back. `extra` supplies any other `Zotero` members the code
 * under test touches.
 */
export async function installPlanStoreZotero(
  extra: Record<string, unknown> = {},
): Promise<() => void> {
  const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
  const previousZotero = globalScope.Zotero;
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (params || []).map((value) =>
      value === undefined ? null : value,
    ) as never[];
  globalScope.Zotero = {
    ...extra,
    DB: {
      queryAsync: async (sql: string, params?: unknown[]) => {
        const statement = db.prepare(sql);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
          return statement
            .all(...bindable(params))
            .map((row) => toZoteroRow(row as Record<string, unknown>));
        statement.run(...bindable(params));
        return [];
      },
      executeTransaction: async (run: () => Promise<unknown>) => {
        db.exec("BEGIN");
        try {
          const result = await run();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  } as unknown as typeof Zotero;
  await initDormantPlanTables();
  return () => {
    db.close();
    globalScope.Zotero = previousZotero;
  };
}
