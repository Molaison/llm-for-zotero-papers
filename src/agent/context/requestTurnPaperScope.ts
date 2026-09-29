import type { ResolvedAgentRuntimeRequest } from "../types";
import {
  listTurnPaperRefs,
  listTurnPapersWithRoles,
  type TurnPaperRef,
  type TurnPaperRole,
  type TurnPaperScope,
} from "./turnPaperScope";

export function getTurnPaperScopeFromRequest(
  request: ResolvedAgentRuntimeRequest,
): TurnPaperScope {
  return request.turnPaperScope;
}

export function getTurnPapers(
  request: ResolvedAgentRuntimeRequest,
): readonly TurnPaperRef[] {
  return listTurnPaperRefs(getTurnPaperScopeFromRequest(request));
}

export function getTurnPapersWithRoles(
  request: ResolvedAgentRuntimeRequest,
  roles: readonly TurnPaperRole[],
): readonly TurnPaperRef[] {
  return listTurnPapersWithRoles(getTurnPaperScopeFromRequest(request), roles);
}

/** Recomputed from the current scope, including papers added after turn one. */
export function isSinglePaperConversation(
  request: ResolvedAgentRuntimeRequest,
): boolean {
  const scope = request.turnPaperScope;
  const papers = new Set(
    [
      ...scope.papers.map(({ paper }) => paper),
      ...scope.selectedPassagePaperRefs.map(({ paper }) => paper),
    ].map((paper) => `${paper.libraryID}:${paper.itemId}`),
  );
  return papers.size === 1 && !scope.collections.length && !scope.tags.length;
}
