declare const Zotero: any;

import type { PaperContextJsonColumns } from "../conversationRegistry";

/**
 * The paper-context JSON columns of every message row that carries at least
 * one of them, for one conversation key.
 *
 * This is the evidence the identity repair and the summary repair both weigh
 * when a conversation's registered scope is missing or contradicts the catalog:
 * if every message in a conversation names the same paper, that paper owns the
 * conversation.  The message table is the only provider-specific part.
 */
export async function getMessagePaperContextRows(
  messagesTable: string,
  conversationKey: number,
): Promise<PaperContextJsonColumns[]> {
  return ((await Zotero.DB.queryAsync(
    `SELECT paper_contexts_json AS paperContextsJson,
            pdf_paper_contexts_json AS pdfPaperContextsJson,
            full_text_paper_contexts_json AS fullTextPaperContextsJson,
            selected_text_paper_contexts_json AS selectedTextPaperContextsJson,
            citation_paper_contexts_json AS citationPaperContextsJson
     FROM ${messagesTable}
     WHERE conversation_key = ?
       AND (
         paper_contexts_json IS NOT NULL OR
         pdf_paper_contexts_json IS NOT NULL OR
         full_text_paper_contexts_json IS NOT NULL OR
         selected_text_paper_contexts_json IS NOT NULL OR
         citation_paper_contexts_json IS NOT NULL
       )`,
    [conversationKey],
  )) || []) as PaperContextJsonColumns[];
}
