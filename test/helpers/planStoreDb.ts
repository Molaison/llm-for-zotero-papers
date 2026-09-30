/**
 * A real SQLite Plan store behind a fake `Zotero`, for tests that read stored
 * Plan executions the way a send does.
 *
 * The rows are proxied because Zotero's rows THROW when code reads a column
 * the SELECT did not name, where a plain node:sqlite row would quietly answer
 * `undefined`.
 */

import { DatabaseSync } from "node:sqlite";
import type {
  ExecutionTask,
  PlanExecutionLedger,
} from "../../src/agent/plans/types";
import { initDormantPlanTables } from "../../src/agent/store/dormantPlanTables";

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
): PlanExecutionLedger {
  const executionId = `execution-${status}-${conversationKey}`;
  const task = (index: number): ExecutionTask => {
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
