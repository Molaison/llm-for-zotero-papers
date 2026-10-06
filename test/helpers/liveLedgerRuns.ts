import type { AgentActionReceipt } from "../../src/agent/types";

/**
 * Two live runs (deepseek-flash, 2026-10-01, the "sized" live suite) that
 * made and verified every change asked for, yet ended
 * completed_with_exceptions. Each holds the exact task_update arguments the
 * model sent and the exact receipts the host recorded, as the run's trace
 * stored them.
 */

/** library.rename_delete_folder: rename one folder, delete an empty one. */
export const RENAME_DELETE_FOLDER = {
  userText:
    'Rename the folder "Old name loopmupsn7f0" to "New name loopmupsn7f0", then delete the empty folder "Empty loopmupsn7f0".',
  taskUpdate: {
    tasks: [
      {
        taskId: "rename",
        description:
          'Rename collection "Old name loopmupsn7f0" to "New name loopmupsn7f0"',
        expectedEffect: "mutation",
        expectedCapability: "zotero.collections",
        targetIds: ["11"],
      },
      {
        taskId: "delete",
        description: 'Delete the empty collection "Empty loopmupsn7f0"',
        expectedEffect: "mutation",
        expectedCapability: "zotero.collections",
      },
    ],
  },
  receipts: [
    {
      version: 2,
      id: "update_collection:0:unmatched:action-1790875440535-120-q6qg54",
      proposalId: "update_collection:0",
      proofDomain: "zotero_state",
      capability: "zotero.collections",
      operation: "update_collection",
      requestedTargets: ["collection:11"],
      rejectedTargets: [],
      normalizedParameters: {
        collectionId: 11,
        collectionName: "New name loopmupsn7f0",
      },
      reasons: [],
      verifiedFacts: [],
      evidenceRef: "action-1790875440535-120-q6qg54:1",
      verification: "verified",
      status: "applied",
      appliedTargets: ["collection:11"],
      alreadySatisfiedTargets: [],
    },
    {
      version: 2,
      id: "delete_collection:0:unmatched:action-1790875440554-124-71q5jx",
      proposalId: "delete_collection:0",
      proofDomain: "zotero_state",
      capability: "zotero.collections",
      operation: "delete_collection",
      requestedTargets: ["collection:12"],
      rejectedTargets: [],
      normalizedParameters: {
        collectionId: 12,
        deleteItems: false,
        permanent: false,
      },
      reasons: [],
      verifiedFacts: [],
      evidenceRef: "action-1790875440554-124-71q5jx:1",
      verification: "verified",
      status: "applied",
      appliedTargets: ["collection:12"],
      alreadySatisfiedTargets: [],
    },
  ] as AgentActionReceipt[],
};

/**
 * library.discover_import: find two papers, create a folder, and import the
 * papers into it with one library_import call that names the folder.
 */
export const DISCOVER_IMPORT = {
  userText:
    'Find two recent papers on representational drift in hippocampus and add them to my library in a new folder "Drift new loopmupsn7f0".',
  taskUpdate: {
    tasks: [
      {
        taskId: "search",
        description:
          "Find two recent papers on representational drift in hippocampus",
        expectedEffect: "read",
        expectedCapability: "external.literature_search",
      },
      {
        taskId: "collection",
        description: 'Create a new collection "Drift new loopmupsn7f0"',
        expectedEffect: "mutation",
        expectedCapability: "zotero.collections",
      },
      {
        taskId: "import",
        description:
          "Add the two selected papers to the library and file them in the new collection",
        expectedEffect: "mutation",
        expectedCapability: "zotero.import",
        targetIds: ["new collection"],
      },
    ],
  },
  receipts: [
    {
      version: 2,
      id: "create_collection:0:unmatched:action-1790875380697-99-pzs8xn",
      proposalId: "create_collection:0",
      proofDomain: "zotero_state",
      capability: "zotero.collections",
      operation: "create_collection",
      requestedTargets: ["collection:9"],
      rejectedTargets: [],
      normalizedParameters: {
        collectionName: "Drift new loopmupsn7f0",
        parentCollectionId: null,
      },
      reasons: [],
      verifiedFacts: [],
      evidenceRef: "action-1790875380697-99-pzs8xn:1",
      verification: "verified",
      status: "applied",
      appliedTargets: ["collection:9"],
      alreadySatisfiedTargets: [],
    },
    {
      version: 2,
      id: "import_identifiers:0:unmatched:action-1790875394476-103-a8ayas",
      proposalId: "import_identifiers:0",
      proofDomain: "zotero_state",
      capability: "zotero.import",
      operation: "import_identifiers",
      requestedTargets: ["item:517", "item:519"],
      rejectedTargets: [],
      normalizedParameters: {
        identifiers: ["10.1101/2025.02.04.636428", "10.1101/2025.10.21.683686"],
        destinationCollectionId: 9,
      },
      reasons: [],
      verifiedFacts: [],
      evidenceRef: "action-1790875394476-103-a8ayas:1",
      verification: "verified",
      status: "applied",
      appliedTargets: ["item:517", "item:519"],
      alreadySatisfiedTargets: [],
    },
  ] as AgentActionReceipt[],
};
