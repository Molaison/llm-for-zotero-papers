import type { ReasoningOption, ReasoningProviderKind } from "../../types";
import type { ReasoningLevel as LLMReasoningLevel } from "../../../../utils/llmClient";
import type { ModelInputMode } from "../../../../shared/types";

import {
  resolveProviderCapabilities,
  type PdfSupport,
} from "../../../../providers";
import { resolveConfiguredModelCapabilities } from "../../../../utils/modelProviders";

export function isScreenshotUnsupportedModel(
  modelName: string,
  providerProtocol?: string,
  authMode?: string,
  apiBase?: string,
  inputMode?: ModelInputMode,
): boolean {
  return !resolveProviderCapabilities({
    model: modelName,
    protocol: providerProtocol,
    authMode,
    apiBase,
    inputMode,
  }).images;
}

export type ModelPdfSupport = PdfSupport;

export function getModelPdfSupport(
  modelName: string,
  providerProtocol?: string,
  authMode?: string,
  apiBase?: string,
  inputMode?: ModelInputMode,
): ModelPdfSupport {
  // CPR's ChatGPT Web route accepts ordered inline PDF parts even though it
  // is intentionally not classified as a first-party OpenAI host. Keep the
  // UI's source picker aligned with the transport's actual contract.
  if (
    inputMode !== "text_only" &&
    resolveConfiguredModelCapabilities({
      model: modelName,
      apiBase: apiBase || "",
    }).directWebPdf
  ) {
    return "native";
  }
  return resolveProviderCapabilities({
    model: modelName,
    protocol: providerProtocol,
    authMode,
    apiBase,
    inputMode,
  }).pdf;
}

export function getScreenshotDisabledHint(modelName: string): string {
  const label = modelName.trim() || "current model";
  return `Screenshots are disabled for ${label}`;
}

export function getReasoningLevelDisplayLabel(
  level: LLMReasoningLevel,
  provider: ReasoningProviderKind,
  modelName: string,
  options: ReasoningOption[],
): string {
  // The level id is the name. Provider-specific synonyms ("enabled", "model")
  // used to be substituted here, which made the chat menu and the model editor
  // disagree about what a level is called.
  void provider;
  void modelName;
  return options.find((entry) => entry.level === level)?.label || level;
}
