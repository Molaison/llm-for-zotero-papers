import { authorizeOriginalAction } from "./policy";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import type {
  ActionProposal,
  ActionReviewInput,
  ActionReviewer,
  ActionReviewRecord,
  AuthorizationDecision,
  OriginalAuthorizationContext,
} from "./types";

/** One invocation owns its review; execution revalidation reuses only unchanged facts. */
export class ActionAuthorizationService {
  private reviewed?: { key: string; result: ActionReviewRecord };

  constructor(private readonly reviewer: ActionReviewer) {}

  async assess(
    proposal: ActionProposal,
    context: OriginalAuthorizationContext,
    input: Omit<ActionReviewInput, "proposal">,
    signal?: AbortSignal,
  ): Promise<{
    authorization: AuthorizationDecision;
    review?: ActionReviewRecord;
  }> {
    const assessment = authorizeOriginalAction(proposal, context);
    if (assessment.kind !== "model_review")
      return { authorization: assessment };
    if (signal?.aborted) throw new Error("Action review cancelled.");
    const facts = { ...input, proposal };
    const key = canonicalJson(facts);
    if (this.reviewed?.key !== key) {
      const started = Date.now();
      let verdict;
      try {
        verdict = await this.reviewer(facts, signal);
        if (
          !["execute", "confirm"].includes(verdict?.decision) ||
          typeof verdict.reason !== "string" ||
          !verdict.reason.trim()
        ) {
          throw new Error("The reviewer returned an invalid decision.");
        }
      } catch {
        verdict = {
          decision: "confirm" as const,
          unavailable: true,
          reason:
            "Auto review could not complete. Review this exact action before running it.",
        };
      }
      if (signal?.aborted) throw new Error("Action review cancelled.");
      this.reviewed = {
        key,
        result: {
          ...verdict,
          proposalDigest: proposal.payloadDigest,
          elapsedMs: Date.now() - started,
        },
      };
    }
    const review = this.reviewed.result;
    return {
      authorization:
        review.decision === "execute"
          ? { kind: "execute", authority: "auto_policy" }
          : { kind: "confirm", reason: review.reason },
      review,
    };
  }
}
