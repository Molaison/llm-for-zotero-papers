import { getNotesDirectoryConfig } from "../../utils/notesDirectoryConfig";
import type { AgentRuntimeRequest } from "../types";

export function createAgentExecutionContext(
  request: AgentRuntimeRequest,
  executionId: string,
  options: {
    notesDirectory?: ReturnType<typeof getNotesDirectoryConfig>;
  } = {},
): NonNullable<AgentRuntimeRequest["executionContext"]> {
  const activePaper = request.turnPaperScope.papers.find((entry) =>
    entry.roles.includes("active"),
  )?.paper;
  const selectedPapers = request.turnPaperScope.papers
    .filter((entry) => entry.roles.includes("selected"))
    .map(({ paper }) => ({
      libraryID: paper.libraryID,
      itemId: paper.itemId,
      contextItemId: paper.contextItemId,
      title: paper.title,
    }));
  const notesDirectory =
    options.notesDirectory === undefined
      ? getNotesDirectoryConfig()
      : options.notesDirectory;
  const taskReadFiles = [
    ...(request.localDocuments || []).map(
      ({ resource }) => resource.absolutePath,
    ),
  ];
  const taskReadDirectories = request.turnPaperScope.papers.flatMap(
    ({ paper }) => (paper.mineruCacheDir ? [paper.mineruCacheDir] : []),
  );
  const outputDirectories = notesDirectory?.directoryPath
    ? [notesDirectory.directoryPath]
    : [];
  return {
    version: 1,
    executionId,
    conversationKey: request.conversationKey,
    conversationGeneration: request.conversationGeneration || 0,
    chatLibraryID:
      request.libraryID || request.turnPaperScope.libraryID || undefined,
    permissionOwner: "original_agent",
    workspaceSnapshot: {
      ...(activePaper
        ? {
            activePaper: {
              libraryID: activePaper.libraryID,
              itemId: activePaper.itemId,
              contextItemId: activePaper.contextItemId,
              title: activePaper.title,
            },
          }
        : {}),
      selectedPapers,
      selectedCollections: request.turnPaperScope.collections.map(
        (collection) => ({
          libraryID: collection.libraryID,
          collectionId: collection.collectionId,
          name: collection.name,
        }),
      ),
      ...(request.activeNoteContext
        ? {
            activeNote: {
              noteId: request.activeNoteContext.noteId,
              parentItemId: request.activeNoteContext.parentItemId,
              title: request.activeNoteContext.title,
            },
          }
        : {}),
    },
    configuredAccess: {
      libraryIDs:
        request.libraryID || request.turnPaperScope.libraryID
          ? [request.libraryID || request.turnPaperScope.libraryID]
          : [],
      outputDirectories,
      fileAccess: {
        readFiles: [...new Set(taskReadFiles)],
        writeFiles: [],
        readDirectories: [
          ...new Set([...outputDirectories, ...taskReadDirectories]),
        ],
        writeDirectories: outputDirectories,
      },
      hostCommandExecution: false,
    },
  };
}
