/**
 * The attachment delegate of library_update (kind:'attachment'): delete,
 * rename, or re-link a Zotero attachment. Not registered on its own; its
 * guidance lives on library_update.
 */
import type { AgentWriteToolDefinition } from "../../types";
import { describeLibraryMutationInput } from "../../contracts/actionContract";
import {
  LibraryMutationService,
  type DeleteAttachmentOperation,
  type RenameAttachmentOperation,
  type RelinkAttachmentOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  executeAndRecordUndo,
  planLibraryMutations,
} from "./mutateLibraryShared";

type AttachmentUpdateInput = {
  operation:
    | DeleteAttachmentOperation
    | RenameAttachmentOperation
    | RelinkAttachmentOperation;
};

export function createAttachmentUpdateTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<AttachmentUpdateInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    describeAction: describeLibraryMutationInput,
    effectOperations: [
      "delete_attachment",
      "rename_attachment",
      "relink_attachment",
    ],
    spec: {
      name: "attachment_update",
      description: "Delete, rename, or re-link Zotero attachments.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "attachmentId"],
        properties: {
          action: {
            type: "string",
            enum: ["delete", "rename", "relink"],
            description:
              "'delete' moves the attachment to trash, 'rename' renames the file on disk, 'relink' points the attachment at a different file.",
          },
          attachmentId: {
            type: "number",
            description: "The Zotero item ID of the attachment.",
          },
          newName: {
            type: "string",
            description: "For action 'rename': the new filename.",
          },
          newPath: {
            type: "string",
            description:
              "For action 'relink': the new absolute path of the file this attachment should point at.",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },

    presentation: {
      label: "Update Attachments",
      summaries: {
        onCall: ({ args }) => {
          const a =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const action = String(a.action || "manage");
          return `Preparing to ${action} attachment`;
        },
        onPending: "Waiting for confirmation on attachment change",
        onApproved: "Applying attachment change",
        onDenied: "Attachment change cancelled",
        onSuccess: "Attachment updated",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with action and attachmentId");
      }
      const action = args.action;
      const attachmentId = normalizePositiveInt(args.attachmentId);
      if (!attachmentId) {
        return fail("attachmentId is required");
      }

      if (action === "delete") {
        const operation: DeleteAttachmentOperation = {
          type: "delete_attachment",
          attachmentId,
        };
        return ok<AttachmentUpdateInput>({ operation });
      }

      if (action === "rename") {
        if (typeof args.newName !== "string" || !args.newName.trim()) {
          return fail("newName is required for action 'rename'");
        }
        const operation: RenameAttachmentOperation = {
          type: "rename_attachment",
          attachmentId,
          newName: args.newName.trim(),
        };
        return ok<AttachmentUpdateInput>({ operation });
      }

      if (action === "relink") {
        if (typeof args.newPath !== "string" || !args.newPath.trim()) {
          return fail("newPath is required for action 'relink'");
        }
        const operation: RelinkAttachmentOperation = {
          type: "relink_attachment",
          attachmentId,
          newPath: args.newPath.trim(),
        };
        return ok<AttachmentUpdateInput>({ operation });
      }

      return fail("action must be one of: 'delete', 'rename', 'relink'");
    },

    createPendingAction(input) {
      const { operation } = input;
      const info = zoteroGateway.getAttachmentInfo({
        attachmentId: operation.attachmentId,
      });
      const title = info?.title || `Attachment ${operation.attachmentId}`;

      if (operation.type === "delete_attachment") {
        return {
          toolName: "attachment_update",
          title: "Delete attachment",
          description: `Move "${title}" to the Zotero trash. This can be undone.`,
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "text" as const,
              id: "info",
              label: "Attachment",
              value: title,
            },
          ],
        };
      }

      if (operation.type === "rename_attachment") {
        return {
          toolName: "attachment_update",
          title: "Rename attachment",
          description: `Rename "${title}" to "${operation.newName}".`,
          confirmLabel: "Rename",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "text" as const,
              id: "from",
              label: "Current name",
              value: title,
            },
            {
              type: "text" as const,
              id: "to",
              label: "New name",
              value: operation.newName,
            },
          ],
        };
      }

      // relink_attachment
      return {
        toolName: "attachment_update",
        title: "Re-link attachment",
        description: `Update the file path for "${title}".`,
        confirmLabel: "Re-link",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "attachment",
            label: "Attachment",
            value: title,
          },
          {
            type: "text" as const,
            id: "path",
            label: "New path",
            value: (operation as RelinkAttachmentOperation).newPath,
          },
        ],
      };
    },

    applyConfirmation(input, resolutionData) {
      // The "New name" and "New path" fields render as real <input> elements
      // the user can type into — there is no read-only text field in this
      // renderer. Discarding the edit meant correcting a wrong filename or a
      // wrong path did nothing, and for re-link, correcting the path is the
      // entire point of the operation.
      const data =
        resolutionData && typeof resolutionData === "object"
          ? (resolutionData as Record<string, unknown>)
          : undefined;
      if (!data) return ok(input);

      if (input.operation.type === "rename_attachment") {
        const edited = typeof data.to === "string" ? data.to.trim() : "";
        if (!edited) {
          return fail(
            "The new attachment name was left empty. Enter a filename or cancel.",
          );
        }
        return ok({
          ...input,
          operation: { ...input.operation, newName: edited },
        });
      }

      if (input.operation.type === "relink_attachment") {
        const edited = typeof data.path === "string" ? data.path.trim() : "";
        if (!edited) {
          return fail(
            "The new file path was left empty. Enter a path or cancel.",
          );
        }
        return ok({
          ...input,
          operation: { ...input.operation, newPath: edited },
        });
      }

      return ok(input);
    },

    planInvocation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "attachment_update",
      );
    },
  };
}
