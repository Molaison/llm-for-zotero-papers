export function formatActionLabel(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export const ACTION_COMPLETION_DISMISS_MS = 5000;

export type ActionCompletionFeedback = {
  status: "success" | "failure";
  title: string;
  description?: string;
  autoDismissMs: number;
};

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function numberField(source: unknown, field: string): number | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function resolveActionCompletionStatusText(params: {
  actionName: string;
  lastProgressSummary?: string | null;
}): string {
  const summary = params.lastProgressSummary?.trim();
  if (summary) {
    return summary;
  }
  return `${formatActionLabel(params.actionName)} complete`;
}

export function resolveActionCompletionFeedback(params: {
  actionName: string;
  output?: unknown;
  lastProgressSummary?: string | null;
}): ActionCompletionFeedback {
  const { actionName, output } = params;
  const summary = params.lastProgressSummary?.trim();
  const fallback = resolveActionCompletionStatusText(params);

  if (actionName === "organize_unfiled") {
    const moved = numberField(output, "moved") ?? 0;
    return {
      status: "success",
      title: moved > 0 ? `Moved ${pluralize(moved, "item")}` : "No items moved",
      description: summary || undefined,
      autoDismissMs: ACTION_COMPLETION_DISMISS_MS,
    };
  }

  if (actionName === "auto_tag") {
    const tagged = numberField(output, "tagged") ?? 0;
    return {
      status: "success",
      title:
        tagged > 0 ? `Tagged ${pluralize(tagged, "item")}` : "No tags applied",
      description: summary || undefined,
      autoDismissMs: ACTION_COMPLETION_DISMISS_MS,
    };
  }

  if (actionName === "discover_related") {
    const imported = numberField(output, "imported") ?? 0;
    return {
      status: "success",
      title:
        imported > 0
          ? `Imported ${pluralize(imported, "paper")}`
          : "No papers imported",
      description: summary || undefined,
      autoDismissMs: ACTION_COMPLETION_DISMISS_MS,
    };
  }

  if (actionName === "audit_library") {
    const fixed = numberField(output, "metadataFixed");
    if (fixed !== undefined) {
      return {
        status: "success",
        title:
          fixed > 0
            ? `Fixed metadata for ${pluralize(fixed, "item")}`
            : "Audit complete",
        description: summary || undefined,
        autoDismissMs: ACTION_COMPLETION_DISMISS_MS,
      };
    }
  }

  return {
    status: "success",
    title: fallback,
    autoDismissMs: ACTION_COMPLETION_DISMISS_MS,
  };
}

export function resolveActionFailureFeedback(params: {
  actionName: string;
  error?: unknown;
  lastProgressSummary?: string | null;
}): ActionCompletionFeedback {
  const errorText =
    params.error instanceof Error
      ? params.error.message
      : typeof params.error === "string"
        ? params.error
        : params.error
          ? String(params.error)
          : "";
  return {
    status: "failure",
    title: `${formatActionLabel(params.actionName)} failed`,
    description:
      errorText || params.lastProgressSummary?.trim() || "The action stopped.",
    autoDismissMs: ACTION_COMPLETION_DISMISS_MS,
  };
}

export function formatActionCompletionCountdown(
  secondsRemaining: number,
): string {
  const seconds = Math.max(1, Math.ceil(secondsRemaining));
  return `Closing in ${seconds} second${seconds === 1 ? "" : "s"}`;
}
