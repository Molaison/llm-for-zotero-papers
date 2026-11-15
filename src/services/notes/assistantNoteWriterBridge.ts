import { createSurfaceBridge } from "../surfaceBridge";
import type { GeneratedChatImage } from "../../shared/types";
import type { CreatedZoteroNoteReceipt } from "../notePersistence";

export type AssistantNoteWriteResult = {
  status: "created" | "appended" | "standalone_created";
  noteId?: number;
  collections?: number[];
  createdNoteReceipt?: CreatedZoteroNoteReceipt;
};

export type AssistantItemNoteWrite = {
  item: Zotero.Item;
  content: string;
  modelName: string;
  appendToTrackedNote?: boolean;
  generatedImages?: GeneratedChatImage[];
};

export type AssistantStandaloneNoteWrite = {
  libraryID: number;
  content: string;
  modelName: string;
  generatedImages?: GeneratedChatImage[];
  collections?: number[];
};

export type AssistantNoteWriter = {
  writeItemNote: (
    params: AssistantItemNoteWrite,
  ) => Promise<AssistantNoteWriteResult>;
  writeStandaloneNote: (
    params: AssistantStandaloneNoteWrite,
  ) => Promise<AssistantNoteWriteResult>;
};

const bridge = createSurfaceBridge<AssistantNoteWriter>(
  "formatted assistant-note writer",
);

export function configureAssistantNoteWriter(
  writer: AssistantNoteWriter | null,
): () => void {
  return bridge.configure(writer);
}

export function writeAssistantItemNote(
  params: AssistantItemNoteWrite,
): Promise<AssistantNoteWriteResult> {
  return bridge.require().writeItemNote(params);
}

export function writeAssistantStandaloneNote(
  params: AssistantStandaloneNoteWrite,
): Promise<AssistantNoteWriteResult> {
  return bridge.require().writeStandaloneNote(params);
}
