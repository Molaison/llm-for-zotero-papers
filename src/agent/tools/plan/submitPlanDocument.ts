import type { AgentToolDefinition } from "../../types";
import type { SubmitPlanDocumentInput } from "../../documents/types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  createSubmitDocumentTool,
  type SubmitPlanDocumentResult,
} from "../control/submitDocument";

/** Legacy factory retained for tests and old integrations; new registries use
 * submit_document exclusively. */
export function createSubmitPlanDocumentTool(
  gateway: ZoteroGateway,
): AgentToolDefinition<SubmitPlanDocumentInput, SubmitPlanDocumentResult> {
  const tool = createSubmitDocumentTool(gateway);
  return {
    // Everything but the spec is inherited, `presentation` included, so this
    // tool stays out of the trace exactly as the one it wraps does. The
    // registry test in `test/agentTraceNoNameMeaning.test.ts` pins that.
    ...tool,
    spec: {
      ...tool.spec,
      name: "submit_plan_document",
      exposure: "internal",
    },
    isAvailable: (request) => request.planContext?.phase === "executing",
  };
}
