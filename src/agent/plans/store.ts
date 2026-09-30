import type {
  ExecutionTask,
  PlanArtifact,
  PlanExecutionLedger,
  TaskEvidence,
} from "./types";
import {
  decodeExecutionTask,
  decodePlanArtifact,
  decodePlanExecutionLedger,
  decodeTaskEvidence,
} from "./decoders";
import {
  decodePlanAmendmentGrant,
  decodePlanAmendmentProposal,
  type PlanAmendmentGrant,
  type PlanAmendmentProposal,
} from "./planAmendmentTypes";

import {
  PLAN_AMENDMENTS_TABLE,
  PLAN_AMENDMENT_PROPOSALS_TABLE,
  PLAN_ARTIFACTS_TABLE,
  PLAN_EXECUTIONS_TABLE,
  PLAN_EXECUTION_TASKS_TABLE,
  PLAN_TASK_EVIDENCE_TABLE,
  PLAN_TASK_TRANSITIONS_TABLE,
} from "../store/dormantPlanTables";

type JsonRow = { payloadJson?: unknown };

function parsePayload<T>(
  row: JsonRow | undefined,
  decoder: (value: unknown) => T,
): T | null {
  if (!row || typeof row.payloadJson !== "string") return null;
  return decoder(JSON.parse(row.payloadJson));
}

export async function savePlanAmendmentProposal(
  proposal: PlanAmendmentProposal,
  status:
    | "awaiting_approval"
    | "authorized"
    | "applied"
    | "failed"
    | "superseded",
  now = Date.now(),
): Promise<void> {
  decodePlanAmendmentProposal(proposal);
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${PLAN_AMENDMENT_PROPOSALS_TABLE}
      (proposal_digest, plan_id, revision, execution_id, conversation_key,
       kind, status, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      proposal.proposalDigest,
      proposal.planId,
      proposal.planRevision,
      proposal.executionId,
      proposal.conversationKey,
      proposal.kind,
      status,
      JSON.stringify(proposal),
      proposal.createdAt,
      now,
    ],
  );
}

export async function updatePlanAmendmentProposalStatus(
  proposalDigest: string,
  status:
    | "awaiting_approval"
    | "authorized"
    | "applied"
    | "failed"
    | "superseded",
  now = Date.now(),
): Promise<void> {
  await Zotero.DB.queryAsync(
    `UPDATE ${PLAN_AMENDMENT_PROPOSALS_TABLE}
     SET status = ?, updated_at = ? WHERE proposal_digest = ?`,
    [status, now, proposalDigest],
  );
}

export async function loadOpenContractRevisionProposal(
  planId: string,
): Promise<PlanAmendmentProposal | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson
     FROM ${PLAN_AMENDMENT_PROPOSALS_TABLE}
     WHERE plan_id = ? AND kind = 'contract_revision'
       AND status IN ('awaiting_approval', 'authorized', 'failed')
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [planId],
  )) as JsonRow[] | undefined;
  if (typeof rows?.[0]?.payloadJson !== "string") return null;
  return decodePlanAmendmentProposal(JSON.parse(rows[0].payloadJson));
}

export async function savePlanAmendmentGrant(
  grant: PlanAmendmentGrant,
): Promise<void> {
  decodePlanAmendmentGrant(grant);
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${PLAN_AMENDMENTS_TABLE}
      (grant_id, proposal_digest, plan_id, revision, execution_id,
       conversation_key, kind, authority, status, payload_json, authorized_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      grant.grantId,
      grant.proposal.proposalDigest,
      grant.proposal.planId,
      grant.proposal.planRevision,
      grant.proposal.executionId,
      grant.proposal.conversationKey,
      grant.proposal.kind,
      grant.authority,
      grant.status,
      JSON.stringify(grant),
      grant.authorizedAt,
      grant.appliedAt || grant.failedAt || grant.authorizedAt,
    ],
  );
}

export async function updatePlanAmendmentGrant(
  grant: PlanAmendmentGrant,
): Promise<void> {
  decodePlanAmendmentGrant(grant);
  await Zotero.DB.queryAsync(
    `UPDATE ${PLAN_AMENDMENTS_TABLE}
     SET status = ?, payload_json = ?, updated_at = ?
     WHERE grant_id = ? AND proposal_digest = ?`,
    [
      grant.status,
      JSON.stringify(grant),
      grant.appliedAt || grant.failedAt || grant.authorizedAt,
      grant.grantId,
      grant.proposal.proposalDigest,
    ],
  );
}

export async function loadPlanAmendmentGrantByProposalDigest(
  proposalDigest: string,
): Promise<PlanAmendmentGrant | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_AMENDMENTS_TABLE}
     WHERE proposal_digest = ? LIMIT 1`,
    [proposalDigest],
  )) as JsonRow[] | undefined;
  return parsePayload(rows?.[0], decodePlanAmendmentGrant);
}

export async function listPlanAmendmentGrants(
  executionId: string,
): Promise<PlanAmendmentGrant[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_AMENDMENTS_TABLE}
     WHERE execution_id = ? ORDER BY authorized_at ASC`,
    [executionId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parsePayload(row, decodePlanAmendmentGrant))
    .filter((grant): grant is PlanAmendmentGrant => Boolean(grant));
}

export async function savePlanArtifact(artifact: PlanArtifact): Promise<void> {
  decodePlanArtifact(artifact);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${PLAN_ARTIFACTS_TABLE}
      (plan_id, revision, conversation_key, provider, status, digest,
       payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      artifact.planId,
      artifact.revision,
      artifact.conversationKey,
      artifact.provider,
      artifact.status,
      artifact.digest,
      JSON.stringify(artifact),
      artifact.createdAt,
      artifact.updatedAt,
    ],
  );
}

export async function loadPlanArtifact(
  planId: string,
  revision: number,
): Promise<PlanArtifact | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_ARTIFACTS_TABLE}
     WHERE plan_id = ? AND revision = ? LIMIT 1`,
    [planId, revision],
  )) as JsonRow[] | undefined;
  return parsePayload(rows?.[0], decodePlanArtifact);
}

export async function loadLatestPlanArtifactForConversation(
  conversationKey: number,
): Promise<PlanArtifact | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_ARTIFACTS_TABLE}
     WHERE conversation_key = ? ORDER BY updated_at DESC, revision DESC LIMIT 1`,
    [conversationKey],
  )) as JsonRow[] | undefined;
  return parsePayload(rows?.[0], decodePlanArtifact);
}

export async function savePlanExecutionLedger(
  ledger: PlanExecutionLedger,
  transition?: {
    taskId: string;
    fromStatus: string;
    toStatus: string;
    payload?: unknown;
    createdAt: number;
  },
  options: { alreadyInTransaction?: boolean } = {},
): Promise<void> {
  decodePlanExecutionLedger(ledger);
  const write = async () => {
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
    if (transition) {
      await Zotero.DB.queryAsync(
        `INSERT INTO ${PLAN_TASK_TRANSITIONS_TABLE}
          (execution_id, task_id, from_status, to_status, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          ledger.executionId,
          transition.taskId,
          transition.fromStatus,
          transition.toStatus,
          JSON.stringify(transition.payload || {}),
          transition.createdAt,
        ],
      );
    }
  };
  if (options.alreadyInTransaction) {
    await write();
  } else {
    await Zotero.DB.executeTransaction(write);
  }
}

export async function loadPlanExecutionLedger(
  executionId: string,
): Promise<PlanExecutionLedger | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_EXECUTIONS_TABLE}
     WHERE execution_id = ? LIMIT 1`,
    [executionId],
  )) as JsonRow[] | undefined;
  const ledger = parsePayload(rows?.[0], decodePlanExecutionLedger);
  if (!ledger) return null;
  const taskRows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_EXECUTION_TASKS_TABLE}
     WHERE execution_id = ? ORDER BY task_order ASC`,
    [executionId],
  )) as JsonRow[] | undefined;
  const tasks = (taskRows || [])
    .map((row) => parsePayload(row, decodeExecutionTask))
    .filter((task): task is ExecutionTask => Boolean(task));
  return { ...ledger, tasks: tasks.length ? tasks : ledger.tasks };
}

export async function loadLatestPlanExecutionForPlan(
  planId: string,
  revision: number,
): Promise<PlanExecutionLedger | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT execution_id AS executionId FROM ${PLAN_EXECUTIONS_TABLE}
     WHERE plan_id = ? AND revision = ? ORDER BY updated_at DESC LIMIT 1`,
    [planId, revision],
  )) as Array<{ executionId?: unknown }> | undefined;
  const executionId =
    typeof rows?.[0]?.executionId === "string"
      ? rows[0].executionId.trim()
      : "";
  return executionId ? loadPlanExecutionLedger(executionId) : null;
}

export async function loadLatestResumablePlanExecutionForConversation(
  conversationKey: number,
): Promise<PlanExecutionLedger | null> {
  // Unit-test and non-Zotero utility callers can render/send without a host DB.
  // Production Zotero always supplies this global; absence means there cannot
  // be a durable execution to resume.
  if (typeof Zotero === "undefined") return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT execution_id AS executionId FROM ${PLAN_EXECUTIONS_TABLE}
     WHERE conversation_key = ?
       AND status IN ('pending', 'running', 'waiting_for_user', 'interrupted')
     ORDER BY updated_at DESC LIMIT 1`,
    [conversationKey],
  )) as Array<{ executionId?: unknown }> | undefined;
  const executionId =
    typeof rows?.[0]?.executionId === "string"
      ? rows[0].executionId.trim()
      : "";
  return executionId ? loadPlanExecutionLedger(executionId) : null;
}

export async function saveTaskEvidence(evidence: TaskEvidence): Promise<void> {
  decodeTaskEvidence(evidence);
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${PLAN_TASK_EVIDENCE_TABLE}
      (evidence_id, execution_id, task_id, kind, verified, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      evidence.evidenceId,
      evidence.executionId,
      evidence.taskId,
      evidence.kind,
      evidence.verified ? 1 : 0,
      JSON.stringify(evidence),
      evidence.createdAt,
    ],
  );
}

export async function listTaskEvidence(
  executionId: string,
  taskId: string,
): Promise<TaskEvidence[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_TASK_EVIDENCE_TABLE}
     WHERE execution_id = ? AND task_id = ? ORDER BY created_at ASC`,
    [executionId, taskId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parsePayload(row, decodeTaskEvidence))
    .filter((evidence): evidence is TaskEvidence => Boolean(evidence));
}

/**
 * Research provenance may be collected by a deep-read task and consumed by a
 * later synthesis task. Recover it from the approved execution boundary rather
 * than from whichever task owns the research job.
 */
export async function listExecutionTaskEvidence(
  executionId: string,
): Promise<TaskEvidence[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_TASK_EVIDENCE_TABLE}
     WHERE execution_id = ? ORDER BY created_at ASC`,
    [executionId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parsePayload(row, decodeTaskEvidence))
    .filter((evidence): evidence is TaskEvidence => Boolean(evidence));
}
