import { isTextOnlyModel } from "./modelChecks";
import type { ProviderCapabilities, ProviderParams } from "./types";
import * as native from "./tiers/native";
import * as serverUpload from "./tiers/serverUpload";
import * as copilot from "./tiers/copilot";
import * as codex from "./tiers/codex";
import * as thirdParty from "./tiers/thirdParty";
import { resolvePromptCacheCapability } from "../contextCache/manager";
import { resolveModelInputMode } from "../utils/modelInputMode";
import { getModelCapabilities } from "../modelCapabilities/service";
import { resolveConfiguredModelCapabilities } from "../utils/modelProviders";

// Evaluate in priority order: auth-mode tiers (copilot, codex) must come
// before protocol-based tiers (native) so that e.g. copilot+responses_api
// is treated as copilot, not as native (which would try /v1/files upload
// against a proxy that doesn't expose it).
const TIERS = [copilot, codex, serverUpload, native, thirdParty] as const;

/**
 * Resolve the full provider capability set for the given request
 * parameters.  This is the single entry point that replaces the
 * scattered getModelPdfSupport / isScreenshotUnsupportedModel /
 * isMultimodalRequestSupported checks.
 */
export function resolveProviderCapabilities(
  params: ProviderParams,
): ProviderCapabilities {
  const matched = TIERS.find((tier) => tier.matches(params));
  const base = matched?.capabilities ?? thirdParty.capabilities;
  const inputMode = resolveModelInputMode(params.inputMode);
  const pdfDisabled =
    inputMode === "text_only" ||
    (inputMode === "auto" && isTextOnlyModel(params.model));
  const cprRoute = resolveConfiguredModelCapabilities({
    model: params.model,
    apiBase: params.apiBase,
  });
  // A compatible Responses endpoint is a wire contract, not evidence that
  // every model behind it accepts PDFs. Account-auth tiers keep their own
  // contracts; vision_allowed alone confirms images, not PDF input.
  const compatibleResponsesPdf =
    (base.tier === "third_party" || base.tier === "server_upload") &&
    params.protocol?.toLowerCase() === "responses_api" &&
    (!params.authMode || params.authMode.toLowerCase() === "api_key") &&
    (inputMode === "pdf_allowed" || getModelCapabilities(params).inputs.pdf);
  const pdf = pdfDisabled
    ? "none"
    : cprRoute.paperRegistry || cprRoute.directWebPdf || compatibleResponsesPdf
      ? "native"
      : base.pdf;
  const images =
    inputMode === "vision_allowed"
      ? true
      : inputMode === "text_only"
        ? false
        : base.images && getModelCapabilities(params).inputs.image;

  return {
    ...base,
    pdf,
    promptCache: resolvePromptCacheCapability(params),
    images,
    multimodal: images || pdf !== "none",
  };
}
