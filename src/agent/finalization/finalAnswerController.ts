import type {
  AgentActionReceipt,
  AgentRuntimeRequest,
  AgentToolEffect,
} from "../types";
import {
  assessWebAttribution,
  type WebAttributionAssessment,
} from "../../webAccess/attribution";
import { literaturePaperIdentities } from "../services/literatureDiscovery";
import {
  openDeclaredOutcomes,
  outcomeProgressSignature,
} from "../loop/outcomes";

export type AgentFinalAnswerToolRecord = {
  name: string;
  ok: boolean;
  mutability?: "read" | "write";
  effect?: AgentToolEffect;
  actionReceipts?: readonly AgentActionReceipt[];
  input?: unknown;
  content?: unknown;
};

type ImportOperationInput = {
  operation?: { type?: unknown; identifiers?: unknown };
};

/**
 * Identifiers of a library_import call: the model's raw arguments, or the
 * facade's validated input, which wraps the import_identifiers operation.
 */
function importedIdentifiers(input: unknown): string[] {
  const raw = (input || {}) as ImportOperationInput & {
    kind?: unknown;
    identifiers?: unknown;
    delegateInput?: ImportOperationInput;
  };
  const operation = raw.delegateInput?.operation || raw.operation;
  const identifiers =
    raw.kind === "identifiers"
      ? raw.identifiers
      : operation?.type === "import_identifiers"
        ? operation.identifiers
        : undefined;
  return Array.isArray(identifiers)
    ? identifiers.filter((id): id is string => typeof id === "string")
    : [];
}

/** Whether a successful identifier import took at least one saved candidate. */
function importsSavedCandidate(
  records: readonly AgentFinalAnswerToolRecord[],
  record: AgentFinalAnswerToolRecord,
): boolean {
  if (!record.ok || record.name !== "library_import") return false;
  const identifiers = importedIdentifiers(record.input);
  if (!identifiers.length) return false;
  const candidates = new Set(
    records
      .filter((entry) => entry.ok && entry.name === "literature_search")
      .flatMap((entry) => {
        const results = (entry.content as { results?: unknown } | undefined)
          ?.results;
        return Array.isArray(results) ? results : [];
      })
      .filter(
        (paper): paper is Record<string, unknown> =>
          Boolean(paper) && typeof paper === "object",
      )
      .flatMap((paper) => literaturePaperIdentities(paper)),
  );
  return identifiers.some((id) =>
    [
      ...literaturePaperIdentities({ doi: id }),
      ...literaturePaperIdentities({ arxivId: id }),
    ].some((key) => candidates.has(key)),
  );
}

export type AgentFinalAnswerDecision =
  | {
      kind: "accept";
      webAttribution: WebAttributionAssessment;
    }
  | {
      kind: "correct";
      correction: string;
      assistantContent?: string;
    }
  | {
      kind: "fail";
      userMessage: string;
    };

/**
 * Applies every runtime-owned final-answer gate through one typed decision.
 * Provider continuation remains outside this class; a correction is an
 * application-owned user message appended after the adapter's cached native
 * final response.
 */
export class AgentFinalAnswerController {
  private webAttributionCorrectionUsed = false;
  private readonly literatureReviewCorrections = new Set<string>();
  /** The ledger's progress when the last outcome correction was given. */
  private outcomeCorrectionSignature?: string;

  constructor(private readonly request: AgentRuntimeRequest) {}

  async evaluate(params: {
    candidateText: string;
    canCorrect: boolean;
    toolExecutionRecords: readonly AgentFinalAnswerToolRecord[];
  }): Promise<AgentFinalAnswerDecision> {
    const unverifiableWrite = params.toolExecutionRecords.find(
      (record) =>
        record.ok &&
        record.mutability === "write" &&
        (record.effect === "applied" || record.effect === "partial") &&
        (!(record.actionReceipts || []).length ||
          (record.actionReceipts || []).some(
            (receipt) =>
              receipt.verification === "unverified" ||
              receipt.status === "unverified",
          )),
    );
    if (unverifiableWrite) {
      return {
        kind: "fail",
        userMessage: `${unverifiableWrite.name} ran, but its concrete effect could not be verified. Inspect current state before retrying it.`,
      };
    }

    const outcomeCorrection = this.openOutcomeCorrection(params.canCorrect);
    if (outcomeCorrection) {
      return { kind: "correct", correction: outcomeCorrection };
    }

    const lastDiscovery = params.toolExecutionRecords.findLastIndex(
      (record) =>
        record.ok &&
        (record.name === "literature_search" ||
          // Retired name, still present in stored tool history.
          record.name === "search_literature_online" ||
          (record.name === "literature_review" &&
            (record.content as { discoveryPhase?: string } | undefined)
              ?.discoveryPhase === "expanding")) &&
        Boolean(
          (record.content as { reviewRequired?: boolean } | undefined)
            ?.reviewRequired,
        ),
    );
    // The search result offers an import branch, so importing its saved
    // candidates also closes discovery.
    if (
      lastDiscovery >= 0 &&
      !params.toolExecutionRecords
        .slice(lastDiscovery + 1)
        .some(
          (record) =>
            (record.ok && record.name === "literature_review") ||
            importsSavedCandidate(params.toolExecutionRecords, record),
        )
    ) {
      const failure =
        "The relevant-paper shortlist was not presented for review, so discovery is not complete.";
      const pending = params.toolExecutionRecords[lastDiscovery].content as
        | { sessionId?: string; revision?: number }
        | undefined;
      const correctionKey = `${pending?.sessionId || "discovery"}:${pending?.revision || 0}`;
      if (
        params.canCorrect &&
        !this.literatureReviewCorrections.has(correctionKey)
      ) {
        this.literatureReviewCorrections.add(correctionKey);
        return {
          kind: "correct",
          correction: `${failure} Use the active discovery sessionId and revision; select only NEW papers for an expansion. Rank genuinely relevant candidates from the saved literature_search results and call literature_review with the requested number, their candidateSetId/candidateIndex references, relevance reasons and destination. Search further if needed; disclose any genuine shortfall. Do not import silently or finish with recommendations in prose.`,
        };
      }
      return { kind: "fail", userMessage: failure };
    }

    const webAttribution = assessWebAttribution(
      params.candidateText,
      params.toolExecutionRecords,
    );
    if (webAttribution.status !== "invalid") {
      return { kind: "accept", webAttribution };
    }
    if (!this.webAttributionCorrectionUsed && params.canCorrect) {
      this.webAttributionCorrectionUsed = true;
      return {
        kind: "correct",
        correction: webAttribution.correctionPrompt,
        assistantContent: webAttribution.cleanText,
      };
    }
    return {
      kind: "fail",
      userMessage:
        "I used web access for this task, but could not safely attach valid paragraph-level sources to the answer.",
    };
  }

  /**
   * The correction that sends an ordinary turn back to the parts the model
   * declared and has not finished. It is given again only after new
   * evidence moved the ledger since the last one.
   */
  private openOutcomeCorrection(canCorrect: boolean): string | undefined {
    if (!canCorrect) return undefined;
    const checkpoint = this.request.executionCheckpoint;
    const open = openDeclaredOutcomes(checkpoint);
    if (!open.length) return undefined;
    const signature = outcomeProgressSignature(checkpoint);
    if (signature === this.outcomeCorrectionSignature) return undefined;
    this.outcomeCorrectionSignature = signature;
    const parts = open.map((task) => `“${task.description}”`).join("; ");
    return `Before answering, finish the parts of this request you declared that are still open: ${parts}. Do them now with the tools. If one cannot be done, call task_update with status skipped or blocked and the reason, then answer.`;
  }
}
