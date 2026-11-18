import type { ModelInputMode } from "../shared/types";

export type ModelInputModeOption = "auto" | ModelInputMode;

export const MODEL_INPUT_MODE_OPTIONS: readonly ModelInputModeOption[] = [
  "auto",
  "text_only",
  "vision_allowed",
  "pdf_allowed",
] as const;

const RUNTIMES_WITH_MANUAL_INPUT_MODE = new Set(["api_key"]);

export function isManualInputModeSupportedForRuntime(
  runtimeMode: unknown,
): boolean {
  return (
    typeof runtimeMode !== "string" ||
    RUNTIMES_WITH_MANUAL_INPUT_MODE.has(runtimeMode)
  );
}

export function getModelInputModeOptionsForRuntime(
  runtimeMode: unknown,
  protocol?: unknown,
): readonly ModelInputModeOption[] {
  return isManualInputModeSupportedForRuntime(runtimeMode)
    ? MODEL_INPUT_MODE_OPTIONS.filter(
        (mode) => mode !== "pdf_allowed" || protocol === "responses_api",
      )
    : [];
}

export function normalizeModelInputMode(
  value: unknown,
): ModelInputMode | undefined {
  if (
    value === "text_only" ||
    value === "vision_allowed" ||
    value === "pdf_allowed"
  )
    return value;
  return undefined;
}

export function normalizeModelInputModeForRuntime(
  value: unknown,
  runtimeMode: unknown,
  protocol?: unknown,
): ModelInputMode | undefined {
  if (!isManualInputModeSupportedForRuntime(runtimeMode)) return undefined;
  const inputMode = normalizeModelInputMode(value);
  // Preserve a dormant API-key setting during storage normalization when
  // the inherited protocol is not yet known. Runtime/UI callers pass it.
  if (
    inputMode === "pdf_allowed" &&
    protocol !== undefined &&
    protocol !== "responses_api"
  )
    return undefined;
  return inputMode;
}

export function resolveModelInputMode(value: unknown): ModelInputModeOption {
  return normalizeModelInputMode(value) || "auto";
}

export function getModelInputModeLabel(
  mode: ModelInputModeOption,
): "Auto" | "Text only" | "Vision allowed" | "PDF allowed" {
  if (mode === "text_only") return "Text only";
  if (mode === "vision_allowed") return "Vision allowed";
  if (mode === "pdf_allowed") return "PDF allowed";
  return "Auto";
}
