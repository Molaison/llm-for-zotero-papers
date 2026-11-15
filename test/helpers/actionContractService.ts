import { ActionContractService } from "../../src/agent/contracts/actionContract";

/**
 * The action-contract service runtime tests run against.
 *
 * Receipts are minted by this service, so a runtime test that asserts
 * anything about a receipt has to hand the registry one. Only the item
 * lookup differs between tests; every other host seam is inert.
 */
export function createTestActionContractService(
  getItem: (itemId: number) => Zotero.Item | null = () => null,
): ActionContractService {
  return new ActionContractService({
    getCollectionSummary: () => null,
    listCollectionSummaries: () => [],
    listCollectionPaperTargets: async () => ({ papers: [] }),
    listCollectionItemTargets: async () => ({ items: [] }),
    getItem,
    getEditableArticleMetadata: () => null,
  });
}
