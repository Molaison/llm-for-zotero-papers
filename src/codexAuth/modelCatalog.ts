import {
  buildCodexReasoningConfig,
  buildCodexReasoningChoices,
  reconcileCodexReasoningChoice,
  type CodexReasoningChoice,
  type CodexReasoningEffort,
} from "../codex/catalogSelection";
import type { ReasoningConfig } from "../shared/llm";
import type { ModelCapabilityLimits } from "../modelCapabilities/types";
import {
  MODEL_CAPABILITY_MAX_TOKEN_LIMIT,
  publishModelCapabilityCatalog,
} from "../modelCapabilities";
import {
  CODEX_DIRECT_RESPONSES_URL,
  fetchWithCodexAuth,
  resolveCodexDirectModelsUrl,
  resolveCodexAuthSession,
  isSameCodexAuthSession,
  type CodexAuthSession,
  type CodexAuthDependencies,
} from "./auth";

import { assertNotAborted, waitForCodexTask } from "./lifecycle";

const CATALOG_TTL_MS = 60_000;
const CATALOG_TIMEOUT_MS = 5_000;
const CODEX_DIRECT_CAPABILITY_IDENTITY = {
  provider: "openai",
  model: "",
  apiBase: CODEX_DIRECT_RESPONSES_URL,
  protocol: "codex_responses",
  authMode: "codex_auth",
} as const;

export type CodexDirectCatalogModel = {
  model: string;
  displayName: string;
  description: string;
  priority: number;
  contextWindow?: number;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
};

export type CodexDirectCatalogSnapshot = {
  status: "idle" | "loading" | "ready" | "error";
  models: CodexDirectCatalogModel[];
  fetchedAt?: number;
  error?: string;
};

export type LoadCodexDirectCatalogOptions = CodexAuthDependencies & {
  force?: boolean;
  timeoutMs?: number;
  now?: () => number;
};

const EMPTY_SNAPSHOT: CodexDirectCatalogSnapshot = {
  status: "idle",
  models: [],
};

let catalogSnapshot = EMPTY_SNAPSHOT;
type CatalogRequest = {
  session: CodexAuthSession;
  controller: AbortController;
  promise: Promise<CodexDirectCatalogSnapshot>;
};

type CatalogLoad = {
  session?: CodexAuthSession;
  promise: Promise<CodexDirectCatalogSnapshot>;
};

let catalogRequest: CatalogRequest | null = null;
let snapshotSession: CodexAuthSession | undefined;
let latestLoad: CatalogLoad | null = null;
let catalogDependenciesForTests: CodexAuthDependencies | undefined;

export function setCodexDirectCatalogDependenciesForTests(
  dependencies?: CodexAuthDependencies,
): void {
  catalogDependenciesForTests = dependencies;
}
const catalogSubscribers = new Set<
  (snapshot: CodexDirectCatalogSnapshot) => void
>();

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeReasoningEfforts(value: unknown): CodexReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const efforts: CodexReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record =
      item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : undefined;
    const effort =
      typeof item === "string"
        ? item.trim()
        : normalizeString(
            record?.effort ??
              record?.reasoning_level ??
              record?.reasoningLevel ??
              record?.value,
          );
    const key = effort.toLowerCase();
    if (!effort || seen.has(key)) continue;
    seen.add(key);
    const description = normalizeString(record?.description);
    efforts.push({
      value: effort,
      ...(description ? { description } : {}),
    });
  }
  return efforts;
}

function normalizeCatalogModel(
  value: unknown,
  serverOrder: number,
): (CodexDirectCatalogModel & { serverOrder: number }) | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (normalizeString(record.visibility).toLowerCase() !== "list") return null;
  const model = normalizeString(record.slug);
  if (!model) return null;
  const priority = normalizeNumber(record.priority) ?? 0;
  const contextWindow = normalizeNumber(record.context_window);
  const defaultReasoningEffort = normalizeString(
    record.default_reasoning_level,
  );
  return {
    model,
    displayName: normalizeString(record.display_name) || model,
    description: normalizeString(record.description),
    priority,
    supportedReasoningEfforts: normalizeReasoningEfforts(
      record.supported_reasoning_levels,
    ),
    ...(contextWindow !== undefined &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow > 0 &&
    contextWindow <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
      ? { contextWindow }
      : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    serverOrder,
  };
}

export function normalizeCodexDirectCatalog(
  payload: unknown,
): CodexDirectCatalogModel[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const rawModels = Array.isArray(record.models)
    ? record.models
    : Array.isArray(record.data)
      ? record.data
      : [];
  const normalized = rawModels
    .map((model, index) => normalizeCatalogModel(model, index))
    .filter(
      (model): model is CodexDirectCatalogModel & { serverOrder: number } =>
        Boolean(model),
    );
  const seen = new Set<string>();
  const unique: Array<CodexDirectCatalogModel & { serverOrder: number }> = [];
  for (const model of normalized) {
    const key = model.model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(model);
  }
  unique.sort(
    (left, right) =>
      right.priority - left.priority || left.serverOrder - right.serverOrder,
  );
  const models: CodexDirectCatalogModel[] = [];
  for (const { serverOrder: _serverOrder, ...model } of unique) {
    models.push(model);
  }
  return models;
}

function publishCatalogSnapshot(snapshot: CodexDirectCatalogSnapshot): void {
  catalogSnapshot = snapshot;
  for (const subscriber of catalogSubscribers) subscriber(snapshot);
}

export function getCodexDirectCatalogSnapshot(): CodexDirectCatalogSnapshot {
  return catalogSnapshot;
}

export function subscribeToCodexDirectCatalog(
  subscriber: (snapshot: CodexDirectCatalogSnapshot) => void,
): () => void {
  catalogSubscribers.add(subscriber);
  return () => catalogSubscribers.delete(subscriber);
}

export async function loadCodexDirectCatalog(
  options: LoadCodexDirectCatalogOptions = {},
): Promise<CodexDirectCatalogSnapshot> {
  options = { ...catalogDependenciesForTests, ...options };
  const now = options.now || Date.now;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Codex Direct model catalog timed out")),
    options.timeoutMs ?? CATALOG_TIMEOUT_MS,
  );
  const load: CatalogLoad = { promise: Promise.resolve(EMPTY_SNAPSHOT) };
  latestLoad = load;
  load.promise = waitForCodexTask(
    Promise.resolve().then(async () => {
      let session: CodexAuthSession;
      try {
        session = await resolveCodexAuthSession({
          ...options,
          signal: controller.signal,
        });
        assertNotAborted(controller.signal);
      } catch (error) {
        if (latestLoad === load) {
          const previous = catalogRequest;
          catalogRequest = null;
          previous?.controller.abort(
            new Error("Codex catalog login changed; please retry"),
          );
          snapshotSession = undefined;
          publishModelCapabilityCatalog(CODEX_DIRECT_CAPABILITY_IDENTITY, []);
          publishCatalogSnapshot({
            status: "error",
            models: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
      load.session = session;
      if (latestLoad !== load) {
        const newer = latestLoad;
        if (!newer)
          throw new Error("Codex catalog load superseded; please retry");
        const result = await waitForCodexTask(newer.promise, controller.signal);
        assertNotAborted(controller.signal);
        if (!newer.session || !isSameCodexAuthSession(session, newer.session)) {
          throw new Error("Codex catalog login changed; please retry");
        }
        return result;
      }
      if (
        catalogRequest &&
        isSameCodexAuthSession(session, catalogRequest.session)
      ) {
        return waitForCodexTask(catalogRequest.promise, controller.signal);
      }
      if (
        !options.force &&
        snapshotSession &&
        isSameCodexAuthSession(session, snapshotSession) &&
        catalogSnapshot.status === "ready" &&
        catalogSnapshot.fetchedAt !== undefined &&
        now() - catalogSnapshot.fetchedAt < CATALOG_TTL_MS
      )
        return catalogSnapshot;

      const previous = catalogRequest;
      catalogRequest = null;
      previous?.controller.abort(
        new Error("Codex catalog login changed; please retry"),
      );
      const owner: CatalogRequest = {
        session,
        controller,
        promise: Promise.resolve(EMPTY_SNAPSHOT),
      };
      catalogRequest = owner;
      snapshotSession = session;
      const assertOwner = () => {
        assertNotAborted(controller.signal);
        if (catalogRequest !== owner)
          throw new Error("Codex catalog load superseded; please retry");
      };
      owner.promise = waitForCodexTask(
        Promise.resolve().then(async () => {
          assertOwner();
          publishModelCapabilityCatalog(CODEX_DIRECT_CAPABILITY_IDENTITY, []);
          publishCatalogSnapshot({ status: "loading", models: [] });
          assertOwner();
          const url = await resolveCodexDirectModelsUrl(options);
          assertOwner();
          const response = await fetchWithCodexAuth(
            url,
            { headers: { Accept: "application/json" } },
            { ...options, signal: controller.signal, session },
          );
          assertOwner();
          if (!response.ok) {
            const detail = await response.text();
            assertOwner();
            throw new Error(
              `Codex Direct catalog failed: ${response.status} ${response.statusText} - ${detail}`,
            );
          }
          const payload = await response.json();
          assertOwner();
          const models = normalizeCodexDirectCatalog(payload);
          publishModelCapabilityCatalog(
            CODEX_DIRECT_CAPABILITY_IDENTITY,
            models.map((model) => ({
              id: model.model,
              displayName: model.displayName,
              source: "live" as const,
            })),
          );
          const snapshot: CodexDirectCatalogSnapshot = {
            status: "ready",
            models,
            fetchedAt: now(),
          };
          publishCatalogSnapshot(snapshot);
          return snapshot;
        }),
        controller.signal,
      )
        .catch((error: unknown) => {
          if (catalogRequest === owner) {
            publishModelCapabilityCatalog(CODEX_DIRECT_CAPABILITY_IDENTITY, []);
            publishCatalogSnapshot({
              status: "error",
              models: [],
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        })
        .finally(() => {
          if (catalogRequest === owner) catalogRequest = null;
        });
      return owner.promise;
    }),
    controller.signal,
  ).finally(() => clearTimeout(timeout));
  return load.promise;
}

export type CodexDirectRequestCatalog = Readonly<{
  assertModelAvailable: (model: string) => void;
  getModelLimits: (
    model: string,
  ) => Readonly<ModelCapabilityLimits> | undefined;
  sanitizeReasoning: (
    model: string,
    reasoning: ReasoningConfig | undefined,
  ) => ReasoningConfig | undefined;
}>;

export function captureCodexDirectRequestCatalog(
  session?: CodexAuthSession,
): CodexDirectRequestCatalog {
  const models =
    session &&
    snapshotSession &&
    catalogSnapshot.status === "ready" &&
    isSameCodexAuthSession(session, snapshotSession)
      ? new Map(
          catalogSnapshot.models.map((model) => [
            model.model.toLowerCase(),
            {
              efforts: model.supportedReasoningEfforts.map(
                (effort) => effort.value,
              ),
              limits: model.contextWindow
                ? Object.freeze({
                    contextWindowTokens: model.contextWindow,
                    inputTokens: model.contextWindow,
                  })
                : undefined,
            },
          ]),
        )
      : undefined;
  return Object.freeze({
    assertModelAvailable(model: string): void {
      if (!models || models.has(model.trim().toLowerCase())) return;
      throw new Error(
        `The Codex Direct model "${model}" is not available in the current catalog. Select another model before sending.`,
      );
    },
    getModelLimits(model: string): Readonly<ModelCapabilityLimits> | undefined {
      return models?.get(model.trim().toLowerCase())?.limits;
    },
    sanitizeReasoning(
      model: string,
      reasoning: ReasoningConfig | undefined,
    ): ReasoningConfig | undefined {
      if (!models) return reasoning ? { ...reasoning } : undefined;
      if (!reasoning?.effort) return undefined;
      return buildCodexReasoningConfig(
        reconcileCodexReasoningChoice(
          reasoning.effort,
          buildCodexReasoningChoices({
            efforts: models.get(model.trim().toLowerCase())?.efforts || [],
          }),
        ),
      );
    },
  });
}

export function getCodexDirectCatalogModel(
  model: string,
): CodexDirectCatalogModel | undefined {
  const key = model.trim().toLowerCase();
  if (!key || catalogSnapshot.status !== "ready") return undefined;
  return catalogSnapshot.models.find(
    (candidate) => candidate.model.toLowerCase() === key,
  );
}

export function assertCodexDirectModelAvailable(model: string): void {
  if (catalogSnapshot.status !== "ready") return;
  if (getCodexDirectCatalogModel(model)) return;
  throw new Error(
    `The Codex Direct model "${model}" is not available in the current catalog. Select another model before sending.`,
  );
}

export function getCodexDirectReasoningChoices(
  model: string,
): CodexReasoningChoice[] {
  const catalogModel = getCodexDirectCatalogModel(model);
  if (!catalogModel) return buildCodexReasoningChoices({ efforts: [] });
  return buildCodexReasoningChoices({
    efforts: catalogModel.supportedReasoningEfforts,
  });
}

export function reconcileCodexDirectReasoningChoice(
  model: string,
  selection: string,
): string {
  if (catalogSnapshot.status !== "ready") return "auto";
  return reconcileCodexReasoningChoice(
    selection,
    getCodexDirectReasoningChoices(model),
  );
}

export function sanitizeCodexDirectReasoningConfig(
  model: string,
  reasoning: ReasoningConfig | undefined,
): ReasoningConfig | undefined {
  if (!reasoning?.effort) return undefined;
  return buildCodexReasoningConfig(
    reconcileCodexDirectReasoningChoice(model, reasoning.effort),
  );
}

export function resetCodexDirectCatalogForTests(): void {
  latestLoad = null;
  snapshotSession = undefined;
  const previous = catalogRequest;
  catalogRequest = null;
  previous?.controller.abort(new Error("Codex catalog reset"));
  publishModelCapabilityCatalog(CODEX_DIRECT_CAPABILITY_IDENTITY, []);
  publishCatalogSnapshot(EMPTY_SNAPSHOT);
}
