import type { AgentToolContext } from "../../types";
import type { ZoteroGateway } from "../zoteroGateway";
import type {
  LibraryMutationExecutionResult,
  LibraryMutationInverse,
  LibraryMutationOperation,
  NativeNoteWriteEvidence,
} from "./contracts";

export type ForwardExecution = {
  result: LibraryMutationExecutionResult;
  inverse?: LibraryMutationInverse | null;
  /**
   * The per-note read-backs an executor that writes several notes already
   * performed. Carried beside the result so the receipt owner can prove each
   * note's content without the bodies travelling to the model.
   */
  noteWrites?: readonly NativeNoteWriteEvidence[];
};

export type ForwardExecutor<Type extends LibraryMutationOperation["type"]> = (
  operation: Extract<LibraryMutationOperation, { type: Type }>,
  context: AgentToolContext,
  zoteroGateway: ZoteroGateway,
) => Promise<ForwardExecution>;

export type ForwardExecutorRegistry = {
  [Type in LibraryMutationOperation["type"]]: ForwardExecutor<Type>;
};
