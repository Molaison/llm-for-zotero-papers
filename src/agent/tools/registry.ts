import { defaultInvocationPlan } from "../authorization/invocationPlan";
import { RETIRED_TOOL_HINTS } from "../context/toolNames";
import type { ActionContractService } from "../contracts/actionContract";
import { operationCatalogEntry } from "../contracts/operationCatalog";
import type { PlanAmendmentService } from "../plans/amendments";
import { isMalformedToolArgumentsDiagnostic } from "../toolArgumentDiagnostics";
import type {
  AgentRuntimeRequest,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  PreparedToolExecution,
  PreparedToolExecutionOptions,
  ToolSpec,
} from "../types";
import { InvocationController } from "./execution/controller";
import { createSyntheticErrorResult } from "./execution/results";
import {
  selectWorkflowStep,
  type PreparedActionBinding,
  type PreparedActionBindings,
} from "./workflowSteps";
function assertPortableModelToolSchema(spec: ToolSpec): void {
  if (spec.exposure === "internal") return;

  const schema = spec.inputSchema;
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>).type !== "object"
  ) {
    throw new Error(
      `Tool "${spec.name}" has an incompatible model-visible inputSchema: the schema root must be a non-array object with type: "object".`,
    );
  }

  for (const keyword of ["oneOf", "allOf", "anyOf"] as const) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword)) {
      throw new Error(
        `Tool "${spec.name}" has an incompatible model-visible inputSchema: root-level "${keyword}" is not portable across providers. Move alternatives into properties and enforce cross-field rules in validate().`,
      );
    }
  }
}

/**
 * An external effect may only be registered when the host can name, before any
 * input exists, exactly which operations it can perform.
 *
 * The per-invocation refusal in `InvocationAssessor.assess` still guards the
 * call itself, but it only fires once a model has chosen arguments and only
 * when the tool's own plan reports an impact. A tool misregistered here would
 * otherwise ship and fail at call time — or never be checked at all, if its
 * `planInvocation` reports `read_only`.
 *
 * `describeAction` output depends on the input, so registration validates the
 * definition's static `effectOperations` instead. `OPERATION_CATALOG` owns the
 * capability and proof domain for each operation, so a declared operation that
 * is absent from it has no proof domain and cannot be authorized or verified.
 * `AgentActionOperation` already makes an unknown operation a compile error;
 * this repeats the check at runtime for definitions that reach the registry
 * from the plugin extension API without passing through the compiler.
 */
function assertTypedActionAdapter(tool: AgentToolDefinition<any, any>): void {
  // Exempt by class: `control` tools (library_batch, workflow_script) own no
  // effect of their own — every child call re-enters this registry.
  if (tool.spec.executionClass !== "external_effect") return;
  const name = tool.spec.name;
  if (!tool.describeAction) {
    throw new Error(
      `Tool "${name}" is registered as external_effect without a typed action adapter: add describeAction so the host can freeze its exact operation, capability, proof domain, and targets.`,
    );
  }
  if (!tool.effectOperations?.length) {
    throw new Error(
      `Tool "${name}" is registered as external_effect without effectOperations: declare every operation its describeAction can produce.`,
    );
  }
  for (const operation of tool.effectOperations) {
    if (!operationCatalogEntry(operation)) {
      throw new Error(
        `Tool "${name}" declares effect operation "${operation}", which is not in the operation catalog: add its capability and proof domain to OPERATION_CATALOG before registering the tool.`,
      );
    }
  }
}

/**
 * Keep provider-bound schemas structural and compact.
 *
 * Tool and operation semantics live in the tool description while JSON Schema
 * owns accepted fields, required values, enums, and numeric bounds. Repeating
 * prose on every nested property more than doubled the fixed tool payload for
 * every model round without strengthening host validation.
 */
function compactModelSchema(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value))
    return value.map((entry) => compactModelSchema(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          propertyMap ||
          (key !== "description" && key !== "title" && key !== "examples"),
      )
      .map(([key, entry]) => [
        key,
        compactModelSchema(entry, key === "properties"),
      ]),
  );
}

const MODEL_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  workflow_script:
    "Compose tool loops or conditions; each call keeps its permission and receipt boundary.",
  library_search:
    "Find or count Zotero items, collections, notes, tags, searches, or libraries.",
  library_read:
    "Read Zotero metadata, notes, annotations, attachments, or memberships.",
  library_retrieve:
    "Retrieve ranked paper evidence from a library scope with explicit coverage.",
  paper_read:
    "Read papers by overview, targeted, full, figures, visual, or visible-page mode. For figure crops use mode:figures and figureLabels (e.g. ['Figure 1']); extracts from the source PDF without requiring MinerU. Preserve the active attachment; a sibling PDF's cache is not the same source.",
  literature_search:
    "Search scholarly sources and save candidates; import only on request.",
  literature_review:
    "Present ranked saved candidates for selection without import.",
  library_update:
    "Change tags, metadata, memberships, parents, or Related links; kind:'collection' creates, renames, moves, or deletes a collection, kind:'attachment' renames, relinks, or deletes one, kind:'savedSearch' saves or deletes one. A membership move removes its named source.",
  context_read:
    "Read exact stored context. source:'conversation': omit messageId to list chat messages, set it to read one. source:'tool_result': read a trh_ handle; omit path for metadata. Continue with offset or textOffset=nextTextOffset.",
  note_write:
    "Write a Zotero note. sourceMessageId reuses an exact answer; documentId reuses finalized material. Markdown file:// images from paper_read figure crops are imported and verified as embedded images; do not reimplement embedding with scripts.",
  note_write_batch:
    "Write notes to explicitly identified items as one checkpointed batch; resumeBatchId continues an interrupted one.",
  library_cite:
    "Format Zotero CSL citations or bibliographies, or export with a translator.",
  library_settings: "Read or change supported Zotero settings and sync state.",
  library_import:
    "Add Zotero items from identifiers, local files, or explicit manual metadata.",
  library_delete:
    "Trash or restore Zotero objects, or merge duplicates into a named master.",
  undo: "Undo the latest reversible journaled action in this chat; count or actionIds revert several, dryRun lists them with conflicts.",
  annotate_pdf:
    "Add a PDF highlight and optional comment using PDF-space rectangles.",
  file_io: "Read or write local files, including partial text and images.",
  run_command: "Run a host shell command and return its output and status.",
  zotero_script: "Run Zotero JavaScript with declared access and effect.",
  load_skill:
    "Load exact instructions for an installed skill ID; this grants no authority.",
  request_user_input:
    "Ask up to three questions when required input cannot be found.",
  submit_document:
    "Persist validated Markdown and evidence as a versioned material reference.",
  update_plan: "Create or revise a read-only explicit Plan artifact.",
  prepare_plan_execution:
    "Stage the exact execution contract and required steps for native Plan review. Acceptance checks may be typed objects or concise strings; the host converts strings into typed evidence requirements. The user remains the sole authority for the later run.",
  task_update:
    "Update tracked work; completion requires host-verifiable evidence.",
  research_update:
    "Persist verified research claims, relationships, work, and evidence.",
  amend_plan:
    "Propose an explicit change to approved Plan scope for renewed review.",
  approve_research_expansion: "Review a bounded research-scope expansion.",
  approve_research_mutation:
    "Review exact effects derived during approved research.",
};

function modelToolSpec(spec: ToolSpec): ToolSpec {
  const compactSchema = compactModelSchema(spec.inputSchema) as Record<
    string,
    unknown
  >;
  return {
    ...spec,
    description: MODEL_TOOL_DESCRIPTIONS[spec.name] || spec.description,
    inputSchema: compactSchema,
  };
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition<any, any>>();

  constructor(
    private readonly actionContracts?: ActionContractService,
    private readonly planAmendments?: PlanAmendmentService,
  ) {}

  async createActionContract(
    request: AgentRuntimeRequest,
  ): Promise<NonNullable<AgentRuntimeRequest["actionContract"]> | null> {
    if (!request.classifiedIntent?.semantic) return null;
    if (this.actionContracts) {
      return this.actionContracts.createContract(request);
    }
    if (
      request.classifiedIntent?.actionIntents.some(
        (intent) => intent.operation !== "read_full",
      )
    ) {
      throw new Error(
        "Action execution requires the native action contract resolver.",
      );
    }
    return null;
  }

  private readonly actionBindings: PreparedActionBindings = new Map();

  registerActionBinding(
    operation: import("../types").AgentActionOperation,
    binding: PreparedActionBinding,
  ): void {
    if (this.actionBindings.has(operation))
      throw new Error(`Duplicate prepared action binding: ${operation}`);
    this.actionBindings.set(operation, binding);
  }

  async getNextWorkflowStep(
    request: AgentRuntimeRequest,
    allowedObligationIds?: readonly string[],
  ) {
    const resolved = this.actionContracts?.resolveWorkflowContract(
      request.actionContract,
      request.actionProgress,
    );
    const step = await selectWorkflowStep(
      resolved ? { ...request, actionContract: resolved } : request,
      this.actionBindings,
      allowedObligationIds,
    );
    if (step.kind !== "action") return step;
    const tool = this.tools.get(step.prepared.call.name);
    const validation = tool?.validate(step.prepared.call.arguments);
    if (!validation?.ok)
      return {
        kind: "blocked" as const,
        code: "invalid_binding" as const,
        reason: `The registered ${step.prepared.call.name} action binding is invalid. No action was executed.`,
      };
    return step;
  }

  createActionProgress(
    contract: NonNullable<AgentRuntimeRequest["actionContract"]>,
  ): NonNullable<AgentRuntimeRequest["actionProgress"]> {
    if (this.actionContracts)
      return this.actionContracts.createProgress(contract);
    return {
      version: 1,
      contractId: contract.id,
      state: "pending",
      correctionCount: 0,
      obligations: contract.obligations.map((obligation) => ({
        obligationId: obligation.id,
        status: "open",
        verifiedTargetIds: [],
        unresolvedTargetIds: [],
        journalStepIds: [],
        failureReasons: [],
      })),
      appliedReceiptKeys: [],
      authorizationGrants: [],
      updatedAt: Date.now(),
    };
  }

  private isModelVisibleTool(tool: AgentToolDefinition<any, any>): boolean {
    return tool.spec.exposure !== "internal";
  }

  private filterToolsForRequest(
    request: AgentRuntimeRequest,
  ): AgentToolDefinition<any, any>[] {
    return Array.from(this.tools.values()).filter(
      (tool) =>
        this.isModelVisibleTool(tool) && tool.isAvailable?.(request) !== false,
    );
  }

  register<TInput, TResult>(tool: AgentToolDefinition<TInput, TResult>): void {
    assertPortableModelToolSchema(tool.spec);
    assertTypedActionAdapter(tool);
    const registered = tool.planInvocation
      ? tool
      : {
          ...tool,
          planInvocation: () => defaultInvocationPlan(tool.spec.executionClass),
        };
    this.tools.set(tool.spec.name, registered);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  listTools(): ToolSpec[] {
    return Array.from(this.tools.values())
      .filter(
        (tool) =>
          this.isModelVisibleTool(tool) && tool.spec.localAgentOnly !== true,
      )
      .map((tool) => modelToolSpec(tool.spec));
  }

  listToolDefinitions(): AgentToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  listToolsForRequest(request: AgentRuntimeRequest): ToolSpec[] {
    return this.filterToolsForRequest(request).map((tool) =>
      modelToolSpec(tool.spec),
    );
  }

  listToolDefinitionsForRequest(
    request: AgentRuntimeRequest,
  ): AgentToolDefinition<any, any>[] {
    return this.filterToolsForRequest(request);
  }

  getTool(name: string): AgentToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  async prepareExecution(
    call: AgentToolCall,
    context: AgentToolContext,
    options: PreparedToolExecutionOptions = {},
  ): Promise<PreparedToolExecution> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      const replacement = Object.prototype.hasOwnProperty.call(
        RETIRED_TOOL_HINTS,
        call.name,
      )
        ? RETIRED_TOOL_HINTS[call.name]
        : undefined;
      return createSyntheticErrorResult(
        call,
        replacement
          ? `Unknown tool: ${call.name}. This tool was renamed; call ${replacement} instead.`
          : `Unknown tool: ${call.name}`,
      );
    }
    if (tool.isAvailable?.(context.request) === false) {
      return createSyntheticErrorResult(
        call,
        `${call.name} is not available for this request`,
      );
    }
    // Authorization happens after input validation and exact effect
    // assessment. A coarse tool label is never the authorization boundary.
    if (isMalformedToolArgumentsDiagnostic(call.arguments)) {
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: ${call.name} received malformed tool arguments from the model. Retry with valid JSON.`,
        { inputRejected: true },
      );
    }
    const suppliedArguments =
      call.arguments &&
      typeof call.arguments === "object" &&
      !Array.isArray(call.arguments)
        ? (call.arguments as Record<string, unknown>)
        : undefined;
    const toolArguments = suppliedArguments
      ? Object.fromEntries(
          Object.entries(suppliedArguments).filter(([key]) => key !== "review"),
        )
      : call.arguments;
    if (
      suppliedArguments?.review !== undefined &&
      typeof suppliedArguments.review !== "boolean"
    ) {
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: review must be true or false.`,
        { inputRejected: true },
      );
    }
    const validation = tool.validate(toolArguments);
    if (!validation.ok) {
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: ${validation.error}`,
        { inputRejected: true },
      );
    }

    return new InvocationController(
      { ...call, arguments: toolArguments },
      tool,
      context,
      options,
      this.actionContracts,
      this.planAmendments,
    ).prepare(validation.value);
  }
}
