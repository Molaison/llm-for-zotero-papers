import type { QuoteCitation } from "../../shared/types";
import type { AgentActionReceipt } from "../contracts/types";
import type { TaskPaperLedgerDelta } from "../context/taskPaperLedger";
import type {
  TrustedReadObservation,
  VerifiedReadSource,
} from "../context/readObservationTypes";
import type { AgentToolArtifact, AgentWorkCategory } from "../types";

export type ZoteroMcpToolActivityEvent = {
  requestId: string;
  runId?: string;
  conversationGeneration?: number;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  serverName: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  artifacts?: AgentToolArtifact[];
  actionReceipts?: AgentActionReceipt[];
  workCategory?: AgentWorkCategory;
  mutability?: "read" | "write";
  profileSignature?: string;
  conversationKey?: number;
  libraryID?: number;
  kind?: "global" | "paper";
  quoteCitations?: QuoteCitation[];
  verifiedReadSources?: VerifiedReadSource[];
  readObservations?: readonly TrustedReadObservation[];
  /**
   * What this successful read call read from each paper, for the Task
   * progress view. Set only on a completed call inside a conversation.
   */
  paperLedgerDelta?: TaskPaperLedgerDelta;
  timestamp: number;
};
