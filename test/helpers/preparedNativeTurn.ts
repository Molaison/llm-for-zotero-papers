import { runCodexAppServerNativeTurn as runPreparedNativeTurn } from "../../src/codexAppServer/nativeClient";
import { buildCodexNativeSkillRequest } from "../../src/codexAppServer/nativeSkills";
import type { AgentRuntimeRequest } from "../../src/agent/types";

// Lifecycle tests use a host-prepared request and never reconstruct authority
// from messages.
type NativeFixtureInput = Omit<
  Parameters<typeof runPreparedNativeTurn>[0],
  "executionRequest" | "eventJournal"
> & {
  eventJournal?: import("../src/agent/store/traceStore").AgentRunEventJournal;
} & Partial<Pick<AgentRuntimeRequest, "skillRoutingReceipt">> & {
    executionRequest?: AgentRuntimeRequest;
    sourceMessageTimestamp?: number;
  };
export const runCodexAppServerNativeTurn = (input: NativeFixtureInput) => {
  const latest = input.messages
    .filter((message) => message.role === "user")
    .at(-1)?.content;
  const request = input.executionRequest || {
    ...buildCodexNativeSkillRequest({
      scope: input.scope,
      userText: typeof latest === "string" ? latest : "Fixture request",
      model: input.model,
      apiBase: input.codexPath,
      skillContext: input.skillContext,
    }),
    executionContext: {
      version: 1 as const,
      executionId: `native-fixture-${input.scope.conversationKey}`,
      conversationKey: input.scope.conversationKey,
      conversationGeneration: input.conversationGeneration || 0,
      chatLibraryID: input.scope.libraryID,
      permissionOwner: "external_runtime" as const,
      workspaceSnapshot: {
        selectedPapers: [],
        selectedCollections: [],
      },
      configuredAccess: {
        libraryIDs: input.scope.libraryID ? [input.scope.libraryID] : [],
        outputDirectories: [],
      },
    },
    metadata: { sourceMessageTimestamp: input.sourceMessageTimestamp },
  };
  return runPreparedNativeTurn({
    ...input,
    executionRequest: request,
    eventJournal: input.eventJournal || {
      runId: "fixture-host-run",
      append: async () => {},
      finish: async () => {},
    },
  });
};
