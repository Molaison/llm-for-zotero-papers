import type { ActionRequestContext } from "./types";

/**
 * How a durable batch job was started, stored with the job so a resumed page
 * keeps it. `preferences` is the per-obligation review preference the
 * classifier-era contract carried; jobs started now store it empty, and a
 * stored one is read only for its validity.
 */
export type BatchInteraction = {
  version: 2;
  entryPoint: "action_ui" | "conversation";
  intentRevision?: number;
  preferences: Array<{
    obligationId: string;
    operation: string;
    reviewPreference: "default" | "review" | "direct";
  }>;
};
export function captureBatchInteraction(request: {
  actionEntryPoint?: "action_ui" | "conversation";
}): BatchInteraction {
  return {
    version: 2,
    entryPoint: request.actionEntryPoint || "conversation",
    preferences: [],
  };
}

export function restoreBatchInteraction(
  request: ActionRequestContext,
  stored: unknown,
): ActionRequestContext {
  const value = stored as Partial<BatchInteraction> | undefined;
  const valid =
    value?.version === 2 &&
    ["action_ui", "conversation"].includes(String(value.entryPoint)) &&
    Array.isArray(value.preferences) &&
    value.preferences.every(
      (entry) =>
        typeof entry.obligationId === "string" &&
        typeof entry.operation === "string" &&
        ["default", "review", "direct"].includes(entry.reviewPreference),
    );
  return {
    ...request,
    actionEntryPoint: valid ? value.entryPoint : "conversation",
  };
}
