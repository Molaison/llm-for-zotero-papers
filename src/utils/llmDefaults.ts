import {
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
} from "../shared/instructionContracts";

export const DEFAULT_TEMPERATURE = 0.3;
/** Seed used only after a user explicitly selects Custom and enters no value. */
export const DEFAULT_CUSTOM_OUTPUT_TOKEN_LIMIT = 8192;
// Output limits are model capabilities too; keep only a corruption guard.
export const MAX_ALLOWED_TOKENS = 100000000;
export const DEFAULT_INPUT_TOKEN_CAP = 256000;
// Provider context windows are discovered at runtime.  Keep a high sanity
// ceiling for malformed values without imposing a product-level 2M limit.
export const MAX_ALLOWED_INPUT_TOKEN_CAP = 100000000;
/** Upper bound on one embeddings request; a hung provider must not stall a read. */
export const EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;
/** Upper bound on one per-paper chunk batch; slow local providers need longer. */
export const EMBEDDING_BATCH_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Default system prompt for non-agent (direct chat) mode.
// Editing this single location updates the prompt everywhere it is used.
// ---------------------------------------------------------------------------
export const DEFAULT_SYSTEM_PROMPT = [
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
].join("\n\n");
