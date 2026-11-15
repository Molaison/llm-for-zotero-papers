/**
 * The plan events old conversations stored, as the read-only plan card and
 * the trace read them back. Plan mode is gone: nothing writes these events
 * now, so these types describe only what a stored run event may carry.
 */

export type StoredPlanScopeSnapshot = Readonly<{
  snapshotId: string;
  digest: string;
  itemCount: number;
  createdAt: number;
  policyVersion: number | string;
}>;

export type StoredPlanArtifact = Readonly<{
  planId: string;
  revision: number;
  status: string;
  explanation?: string;
  steps?: readonly Readonly<{ content: string }>[];
  nativePlanning?: Readonly<{
    proposal?: Readonly<{ markdown?: string }>;
  }>;
  contract?: Readonly<{
    deliverable: Readonly<{ kind: string }>;
    investigation?: Readonly<{ scopeSnapshot?: StoredPlanScopeSnapshot }>;
    effects?: Readonly<{
      libraryMutation?: Readonly<{ approval?: string }>;
    }>;
  }>;
}>;

export type StoredPlanExecution = Readonly<{
  planId: string;
  revision: number;
  status: string;
  tasks?: readonly Readonly<{
    taskId: string;
    status: string;
    content?: string;
    activeForm?: string;
  }>[];
}>;

export type StoredPlanEvent =
  | Readonly<{
      type: "plan_updated" | "plan_ready";
      artifact: StoredPlanArtifact;
    }>
  | Readonly<{ type: "plan_execution_updated"; ledger: StoredPlanExecution }>
  | Readonly<{
      type: "plan_scope_amended";
      amendmentId: string;
      mode: string;
      rationale: string;
      previousItemCount: number;
      newItemCount: number;
      authority: string;
    }>;

/** A stored run event read as an old plan event, or null for any other. */
export function readStoredPlanEvent(payload: unknown): StoredPlanEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Record<string, unknown>;
  const object = (value: unknown) =>
    Boolean(value && typeof value === "object");
  switch (event.type) {
    case "plan_updated":
    case "plan_ready":
      return object(event.artifact) ? (event as StoredPlanEvent) : null;
    case "plan_execution_updated":
      return object(event.ledger) ? (event as StoredPlanEvent) : null;
    case "plan_scope_amended":
      return event as StoredPlanEvent;
    default:
      return null;
  }
}
