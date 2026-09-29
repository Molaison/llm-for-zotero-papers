import type {
  AgentActionCapability,
  AgentActionContract,
  AgentActionObligation,
  AgentActionOperation,
  AgentActionProgressLedger,
  AgentActionReceipt,
  AgentToolEffect,
} from "../types";
import {
  AGENT_ACTION_VERIFICATION_LABELS,
  readAgentActionVerification,
} from "./actionVerificationLabels";
import { innermostToolResult } from "./toolResultEnvelope";
import { operationCatalogEntry } from "./operationCatalog";

export type ContractEvaluation = {
  state:
    | "pending"
    | "satisfied"
    | "partial"
    | "cancelled"
    | "failed"
    | "unverified";
  correction?: string;
  failure?: string;
};

/** Shared completion boundary for original and native provider turns. */
export function evaluatePreparedActionContract(
  request: Pick<
    import("../types").AgentRuntimeRequest,
    | "actionContract"
    | "actionProgress"
    | "actionPreparation"
    | "classifiedIntent"
  >,
  receipts: AgentActionReceipt[],
): ContractEvaluation {
  const delegated = receipts.filter(
    (receipt) =>
      receipt.executionAuthority === "external_runtime" &&
      !isConnectedRuntimeSideEffect(receipt),
  );
  if (delegated.length) {
    // The calling agent owns action intent. Report the actual effects without
    // reinterpreting them through Original Agent obligations or inviting replay.
    if (delegated.every(receiptProved)) return { state: "satisfied" };
    const state = delegated.some((receipt) => receipt.status === "failed")
      ? "failed"
      : delegated.every((receipt) => receipt.status === "cancelled")
        ? "cancelled"
        : delegated.some(
              (receipt) =>
                receipt.status === "partial" || receiptProved(receipt),
            )
          ? "partial"
          : "unverified";
    return {
      state,
      failure: `Delegated action results:\n${formatReceiptStatus(delegated)}`,
    };
  }
  if (!request.actionContract && !request.classifiedIntent?.semantic) {
    const unverifiableApplied = receipts.filter(
      (receipt) =>
        (receipt.status === "applied" || receipt.status === "partial") &&
        receipt.verification === "unverified",
    );
    return unverifiableApplied.length
      ? {
          state: "unverified",
          failure: `Concrete action results could not be verified:\n${formatReceiptStatus(unverifiableApplied)}`,
        }
      : { state: "satisfied" };
  }
  if (
    request.actionPreparation &&
    request.actionPreparation.state !== "ready"
  ) {
    return {
      state: "failed",
      failure:
        request.actionPreparation.issues.join(" ") ||
        "Semantic action preparation is incomplete; completion cannot be verified.",
    };
  }
  const contract = request.actionContract;
  if (
    !contract &&
    request.actionPreparation?.state === "ready" &&
    request.classifiedIntent?.semantic &&
    request.classifiedIntent.writeDisposition === "none" &&
    !request.classifiedIntent.actionIntents.length &&
    !request.classifiedIntent.semantic.questions.length
  )
    return { state: "satisfied" };
  if (contract?.version !== 4 || !contract.intent?.semantic) {
    return {
      state: "failed",
      failure:
        "A current semantic action contract is unavailable; no completed action can be claimed.",
    };
  }
  const actions = evaluateActionContract(
    contract,
    receipts,
    request.actionProgress,
  );
  const missingOutputs = (
    contract.intent.semantic.materialOutputs || []
  ).filter(
    (output) =>
      !request.actionProgress?.materialOutputs?.some(
        (material) => material.outputId === output.id,
      ),
  );
  if (missingOutputs.length && actions.state === "satisfied")
    return {
      state: "pending",
      correction: `Finalize the remaining requested material with submit_document: ${missingOutputs.map((output) => output.id).join(", ")}. The earlier actions are already verified; do not repeat them.`,
    };
  return actions;
}

const ACTION_CORRECTION_GUIDANCE: Partial<
  Record<AgentActionCapability, string>
> = {
  "zotero.tags":
    "Use library_search to resolve IDs, then library_update with the exact tag verb and values.",
  "zotero.metadata":
    "Use library_search to resolve IDs, then library_update with the exact metadata operation.",
  "zotero.collections":
    "Use library_update with the exact collection operation (kind:'collections' for membership, kind:'collection' for the collection itself).",
  "zotero.notes":
    "Use note_write or note_write_batch with the requested edit mode.",
  "zotero.import": "Use library_import with the requested import mode.",
  "zotero.trash":
    "Use library_delete with the exact trash, restore, or merge operation.",
  "zotero.attachments":
    "Use library_update kind:'attachment' with the exact attachment operation.",
  "zotero.read": "Use paper_read with mode:'full'.",
  "zotero.settings": "Use library_settings with the exact key and value.",
  "zotero.undo": "Use the requested undo or revert operation.",
  "file.write": "Use file_io with the exact path and content.",
  "command.execute": "Use run_command for the explicitly requested command.",
  "zotero.script":
    "Use zotero_script only for the explicitly requested execution.",
};

export function actionToolGuidanceForCapabilities(
  capabilities: Iterable<AgentActionCapability>,
): string {
  return [
    ...new Set(
      [...capabilities]
        .map((capability) => ACTION_CORRECTION_GUIDANCE[capability])
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ].join(" ");
}

export function createUnverifiedReceipt(params: {
  capability?: AgentActionCapability;
  operation?: AgentActionOperation;
  proofDomain?: AgentActionReceipt["proofDomain"];
  status?: AgentActionReceipt["status"];
  reason: string;
}): AgentActionReceipt {
  const operation = params.operation || "read_full";
  return {
    version: 2,
    id: `unverified:${operation}:${Date.now()}`,
    proposalId: `unverified:${operation}`,
    proofDomain: params.proofDomain || "zotero_state",
    capability: params.capability || "zotero.read",
    operation,
    verification:
      params.status === "cancelled" ? "not_applicable" : "unverified",
    status: params.status || "failed",
    requestedTargets: [],
    appliedTargets: [],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [params.reason],
    verifiedFacts: [],
  };
}

/** Used only outside the configured Agent contract service. */
export function createFallbackToolReceipts(params: {
  toolName: string;
  executionClass: "read" | "control" | "external_effect";
  input: unknown;
  ok: boolean;
  effect?: AgentToolEffect;
  cancelled?: boolean;
  reason?: string;
  content?: unknown;
  actionContract?: AgentActionContract;
}): AgentActionReceipt[] {
  if (
    params.executionClass === "read" &&
    params.ok &&
    params.input &&
    typeof params.input === "object" &&
    (params.input as { mode?: unknown }).mode === "full"
  ) {
    const matchingObligations = (
      params.actionContract?.obligations || []
    ).filter(
      (obligation) =>
        obligation.operation === "read_full" &&
        obligation.proofDomain === "zotero_state",
    );
    return [
      {
        version: 2,
        id: "read_full:fallback",
        proposalId: "read_full:fallback",
        proofDomain: "zotero_state",
        capability: "zotero.read",
        operation: "read_full",
        obligationId:
          matchingObligations.length === 1
            ? matchingObligations[0].id
            : undefined,
        verification: "verified",
        status: "observed",
        requestedTargets: [],
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: ["read_mode:full"],
      },
    ];
  }
  if (params.executionClass !== "external_effect") return [];
  const operation =
    params.toolName === "file_io"
      ? "file_write"
      : params.toolName === "run_command"
        ? "command_execute"
        : params.toolName === "zotero_script"
          ? "zotero_script_execute"
          : null;
  if (!operation) return [];
  const authority = operationCatalogEntry(operation);
  if (!authority) return [];
  const { capability, proofDomain } = authority;
  if (params.toolName === "file_io" && params.ok) {
    const content = innermostToolResult(params.content);
    const filePath = String(content.filePath || "");
    const expected = String(content.expectedContentHash || "");
    const actual = String(content.contentHash || "");
    const verified =
      Boolean(filePath) &&
      content.exists === true &&
      Boolean(actual) &&
      expected === actual;
    return [
      {
        version: 2,
        id: `file_write:fallback:${filePath}`,
        proposalId: `file_write:fallback:${filePath}`,
        proofDomain,
        capability: "file.write",
        operation: "file_write",
        verification: verified ? "verified" : "unverified",
        status: verified ? "applied" : "unverified",
        requestedTargets: filePath ? [`file:${filePath}`] : [],
        appliedTargets: verified ? [`file:${filePath}`] : [],
        alreadySatisfiedTargets: [],
        rejectedTargets: verified || !filePath ? [] : [`file:${filePath}`],
        reasons: verified
          ? []
          : [
              "The file write did not include exact-path content readback proof.",
            ],
        verifiedFacts: [],
        evidenceRef: verified ? `sha256:${actual}` : undefined,
      },
    ];
  }
  if (
    (params.toolName === "run_command" ||
      params.toolName === "zotero_script") &&
    params.ok
  ) {
    return [
      {
        version: 2,
        id: `${operation}:fallback`,
        proposalId: `${operation}:fallback`,
        proofDomain,
        capability,
        operation,
        verification: "execution_only",
        status: "observed",
        requestedTargets: [],
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: [],
      },
    ];
  }
  return [
    createUnverifiedReceipt({
      operation,
      capability,
      proofDomain,
      status: params.cancelled
        ? "cancelled"
        : params.ok && params.effect === "partial"
          ? "partial"
          : params.ok
            ? "unverified"
            : "failed",
      reason:
        params.reason ||
        "No typed action verifier is configured for this execution path.",
    }),
  ];
}

function itemTarget(itemId: number): string {
  return `item:${itemId}`;
}

function receiptMatches(
  receipt: AgentActionReceipt,
  obligation: AgentActionObligation,
): boolean {
  return receipt.obligationId === obligation.id;
}

/**
 * An effect the connected client ran inside its own runtime.
 *
 * A file Claude Code wrote or a command Codex executed is receipted and
 * journaled so the trace and the audit trail show it, but it says nothing
 * about the Zotero action the turn owes. Reading it as delegated action
 * evidence would break completion in both directions: a shell command would
 * stand in for an unperformed tag write, and an approved command — whose proof
 * can only ever be `execution_only` — would report an otherwise complete turn
 * as unverified.
 *
 * The test is provenance, not capability. A `file.write` receipt can equally
 * come from `file_io` run as a host tool, which the host journaled and
 * verified and which is delegated evidence like any other; reading the
 * capability as a proxy would only work while that tool stays off the MCP
 * surface, and would break silently on the day it is exposed. `origin` is set
 * by exactly one owner and says what actually matters: the host executed
 * nothing here.
 */
function isConnectedRuntimeSideEffect(receipt: AgentActionReceipt): boolean {
  return receipt.origin === "connected_runtime";
}

function receiptTookEffect(receipt: AgentActionReceipt): boolean {
  return (
    receipt.status === "applied" ||
    receipt.status === "already_satisfied" ||
    receipt.status === "observed"
  );
}

function receiptVerified(receipt: AgentActionReceipt): boolean {
  return receipt.verification === "verified" && receiptTookEffect(receipt);
}

/**
 * The receipt carries the strongest proof its proof domain admits.
 *
 * `verified` is a re-read that matched. `execution_only` is the whole proof a
 * shell command or an effect-free script can ever have: it ran, and there is
 * no state to read back. Phase 3 task 3 ruled that such a receipt passes the
 * host's own final gate, so the delegated gate must not read it as a failure
 * either — a client that ran one would be told its complete turn was
 * unverified and invited to run the command a second time.
 *
 * `unverified` stays a failure in both gates: there a re-read was possible
 * and either disagreed or never happened.
 */
function receiptProved(receipt: AgentActionReceipt): boolean {
  return (
    (receipt.verification === "verified" ||
      receipt.verification === "execution_only") &&
    receiptTookEffect(receipt)
  );
}

/**
 * A requested action the host dropped during contract building has no
 * obligation to satisfy, so nothing else in this evaluation would notice it.
 * It counts as done only when some receipt shows the same operation actually
 * took effect; an unmatched judgment receipt qualifies, because in yolo the
 * agent is expected to perform the dropped action with a target of its own
 * choosing.
 */
function uncoveredSkippedActions(
  contract: AgentActionContract,
  receipts: AgentActionReceipt[],
): string {
  const effective = new Set(
    receipts
      .filter(
        (receipt) =>
          receipt.status === "applied" ||
          receipt.status === "already_satisfied" ||
          receipt.status === "partial" ||
          receipt.status === "observed",
      )
      .map((receipt) => receipt.operation),
  );
  const uncovered = [
    ...new Set(
      (contract.skippedActions || [])
        .filter((skipped) => !effective.has(skipped.operation))
        .map((skipped) => skipped.operation),
    ),
  ];
  return uncovered
    .map(
      (operation) =>
        `The requested ${operation.replace(/_/g, " ")} could not be resolved and was not performed.`,
    )
    .join(" ");
}

export function evaluateActionContract(
  contract: AgentActionContract,
  receipts: AgentActionReceipt[],
  progress?: AgentActionProgressLedger,
): ContractEvaluation {
  const skippedFailure = uncoveredSkippedActions(contract, receipts);
  // The action contract is a completion contract, not a retrospective tool
  // allowlist. Authorization already enforced hard constraints before a tool
  // could run. With no requested obligations there is therefore nothing for
  // finalization to prove, and unrelated rejected, cancelled, or unverified
  // exploratory calls must not invalidate an informational answer.
  if (!contract.obligations.length) {
    return skippedFailure
      ? { state: "failed", failure: skippedFailure }
      : { state: "satisfied" };
  }
  const missing: AgentActionObligation[] = [];
  const failed: AgentActionObligation[] = [];
  let sawPartial = false;
  let sawUnverified = false;
  for (const obligation of contract.obligations) {
    const obligationProgress = progress?.obligations.find(
      (entry) => entry.obligationId === obligation.id,
    );
    if (obligationProgress?.status === "cancelled") {
      return {
        state: "cancelled",
        failure: `The requested ${obligation.operation} action was cancelled; no corrective retry was attempted.`,
      };
    }
    if (
      obligationProgress?.status === "fulfilled" ||
      obligationProgress?.status === "already_satisfied"
    ) {
      continue;
    }
    const matching = receipts.filter((receipt) =>
      receiptMatches(receipt, obligation),
    );
    // What credits an obligation is the strongest proof its own proof domain
    // admits. `execution` has no state to read back, so `execution_only` —
    // which both completion gates accept — is what an execution obligation
    // can be shown. Every other domain still requires a re-read that matched,
    // and a receipt only ever matches an obligation of its own operation, so
    // this never lets a command stand in for a library write.
    const credited = matching.filter(
      obligation.proofDomain === "execution" ? receiptProved : receiptVerified,
    );
    if (
      matching.some((receipt) => receipt.status === "cancelled") &&
      !credited.length
    ) {
      return {
        state: "cancelled",
        failure: `The requested ${obligation.operation} action was cancelled; no corrective retry was attempted.`,
      };
    }
    if (matching.some((receipt) => receipt.status === "failed")) {
      failed.push(obligation);
    }
    if (
      obligation.targetBoundary &&
      (obligation.scopeRole !== "destination" || obligation.destinationCreation)
    ) {
      const covered = new Set(
        credited.flatMap((receipt) => [
          ...receipt.appliedTargets,
          ...receipt.alreadySatisfiedTargets,
        ]),
      );
      if (
        !obligation.targetBoundary.frozenTargetIds.every((itemId) =>
          covered.has(itemTarget(itemId)),
        )
      ) {
        missing.push(obligation);
      }
    } else if (!credited.length) {
      missing.push(obligation);
    }
    sawPartial ||= matching.some((receipt) => receipt.status === "partial");
    sawUnverified ||= matching.some(
      (receipt) => receipt.verification === "unverified",
    );
  }
  if (!missing.length)
    return skippedFailure
      ? { state: "failed", failure: skippedFailure }
      : { state: "satisfied" };

  const labels = missing.map((obligation) => {
    const scope = obligation.scope
      ? ` in exact collection "${obligation.scope.collectionPath}" (${obligation.targetBoundary?.frozenTargetIds.length || 0} frozen targets)`
      : obligation.targetBoundary?.kind === "library"
        ? ` in frozen library scope (${obligation.targetBoundary.frozenTargetIds.length} targets)`
        : "";
    return `${obligation.operation} coverage:${obligation.coverage}${scope}`;
  });
  const failureReasons = [
    ...new Set(
      missing.flatMap((obligation) =>
        receipts
          .filter((receipt) => receiptMatches(receipt, obligation))
          .flatMap((receipt) => receipt.reasons),
      ),
    ),
  ];
  const state =
    failed.length || skippedFailure
      ? "failed"
      : sawPartial
        ? "partial"
        : sawUnverified
          ? "unverified"
          : "pending";
  const guidance = actionToolGuidanceForCapabilities(
    missing.map((obligation) => obligation.capability),
  );
  return {
    state,
    correction:
      `Correction for this turn: open typed obligation(s): ${labels.join("; ")}. ` +
      `${guidance} Retry only unresolved targets. Completion requires independently verified post-state; a successful call, command exit, script output, or model prose is not semantic proof.`,
    failure:
      `I could not verify completion of: ${labels.join("; ")}.` +
      (failureReasons.length ? ` ${failureReasons.join("; ")}` : "") +
      (skippedFailure ? ` ${skippedFailure}` : ""),
  };
}

/**
 * The per-receipt status block, written for the model that reads the answer.
 *
 * This text is appended to the answer the runtime finalizes, which is at once
 * the transcript the model reads next turn, the correction it receives this
 * turn, and the string the panel renders. The first two audiences need the
 * machine-readable statement; the reader gets the same facts as a card at the
 * end of the trace, so the panel removes the block at display time with
 * `stripReceiptStatusForDisplay` and nothing changes about what is persisted.
 * A receipt journaled before the verification field existed states no proof,
 * and the block leaves it out rather than printing an empty claim.
 */
export function formatReceiptStatus(receipts: AgentActionReceipt[]): string {
  return receipts
    .map((receipt) => {
      const verified =
        receipt.appliedTargets.length + receipt.alreadySatisfiedTargets.length;
      const coverage = receipt.requestedTargets.length
        ? ` ${verified}/${receipt.requestedTargets.length}`
        : "";
      const verification = readAgentActionVerification(receipt.verification);
      const proof = verification
        ? ` ${AGENT_ACTION_VERIFICATION_LABELS[verification]};`
        : "";
      return `[Action status: ${receipt.operation} — ${receipt.status}${coverage};${proof} proof:${receipt.proofDomain}]`;
    })
    .join("\n");
}

/**
 * The statuses under which a receipt claims the turn did something.
 *
 * Work that landed, work that was already true, work that landed for some of
 * its targets, and an effect that ran with nothing to re-read afterwards. A
 * cancelled or failed action is reported where it failed; counting it here
 * would say the opposite of what happened.
 */
const REPORTED_EFFECT_STATUSES: ReadonlySet<AgentActionReceipt["status"]> =
  new Set(["applied", "already_satisfied", "partial", "observed"]);

/**
 * Whether a receipt states an effect worth reporting as work the turn did.
 *
 * One predicate serves the model-facing status block and the reader-facing
 * summary card, so the two can never come to disagree about what the turn
 * did. Reads are excluded deliberately: a full read journals a receipt to
 * prove the evidence was actually consulted, and answering a question after
 * reading a paper is not an action taken on the library.
 */
export function receiptReportsEffect(
  receipt: Pick<AgentActionReceipt, "capability" | "status">,
): boolean {
  return (
    receipt.capability !== "zotero.read" &&
    REPORTED_EFFECT_STATUSES.has(receipt.status)
  );
}

/** One finished block line, exactly as `formatReceiptStatus` writes it. */
const RECEIPT_STATUS_LINE = /^\[Action status:[^\n]*\]\s*$/;

/**
 * The block's last line while the answer is still streaming, before its
 * closing bracket has arrived.
 */
const RECEIPT_STATUS_PARTIAL_LINE = /^\[Action status:[^\]\n]*$/;

/**
 * The answer without the block `formatReceiptStatus` appended to it.
 *
 * The runtime concatenates the block onto the end of the final text, so this
 * removes the trailing run of block lines and the blank line that separated
 * them from the answer, and nothing else: an action-status line the answer
 * itself quotes sits before other content and is left alone. The incremental
 * render path sees the block one delta at a time, so a last line that has
 * opened the block without closing it goes too, rather than flashing a half
 * written receipt at the reader.
 */
export function stripReceiptStatusForDisplay(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end && !lines[end - 1].trim()) end -= 1;
  const blockEnd = end;
  if (end && RECEIPT_STATUS_PARTIAL_LINE.test(lines[end - 1])) end -= 1;
  while (end && RECEIPT_STATUS_LINE.test(lines[end - 1])) end -= 1;
  if (end === blockEnd) return text;
  while (end && !lines[end - 1].trim()) end -= 1;
  return lines.slice(0, end).join("\n");
}
