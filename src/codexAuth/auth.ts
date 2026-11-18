import { assertNotAborted, waitForCodexTask } from "./lifecycle";
import { getCodexHomePref } from "../utils/codexHomePref";
import { getLocalParentPath, joinLocalPath } from "../utils/localPath";

export const CODEX_DIRECT_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
// Direct's tested backend compatibility floor. The catalog filters models by
// client_version, so 0.0.0 silently hides newer models, including GPT-6.1 Sol.
export const CODEX_DIRECT_CLIENT_VERSION = "0.162.1";
export const CODEX_DIRECT_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_DIRECT_CLIENT_VERSION}`;

const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type IOUtilsLike = {
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  write?: (
    path: string,
    data: Uint8Array,
    options?: { tmpPath?: string },
  ) => Promise<unknown>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
};

type OSFileLike = {
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  writeAtomic?: (
    path: string,
    data: Uint8Array,
    options?: { tmpPath?: string },
  ) => Promise<void>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
};

type ProcessLike = { env?: Record<string, string | undefined> };
type PathUtilsLike = { homeDir?: string };
type ServicesLike = {
  dirsvc?: {
    get?: (key: string, iface?: unknown) => { path?: string } | undefined;
  };
};
type OSLike = { Constants?: { Path?: { homeDir?: string } } };

type CodexTokenData = Record<string, unknown> & {
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
};

export type CodexAuthJson = Record<string, unknown> & {
  tokens?: CodexTokenData;
  last_refresh?: string;
};

export type CodexAuthSession = {
  token: string;
  refreshToken: string;
  accountId?: string;
  authPath: string;
};

export type CodexAuthDependencies = {
  authPath?: string;
  refreshTimeoutMs?: number;
  fetchFn?: typeof fetch;
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, content: string) => Promise<void>;
};

type CodexRefreshTask = {
  phase: "preparing" | "committing" | "settling";
  session: CodexAuthSession;
  controller: AbortController;
  promise: Promise<CodexAuthSession>;
};

const refreshTasksByAuthPath = new Map<string, CodexRefreshTask>();

function getIOUtils(): IOUtilsLike | undefined {
  const direct = (globalThis as { IOUtils?: IOUtilsLike }).IOUtils;
  if (direct?.read) return direct;
  const toolkit = ztoolkit.getGlobal("IOUtils") as IOUtilsLike | undefined;
  return toolkit?.read ? toolkit : undefined;
}

function getOSFile(): OSFileLike | undefined {
  const direct = (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
  if (direct?.read) return direct;
  const toolkit = ztoolkit.getGlobal("OS") as { File?: OSFileLike } | undefined;
  return toolkit?.File?.read ? toolkit.File : undefined;
}

function getProcess(): ProcessLike | undefined {
  const direct = (globalThis as { process?: ProcessLike }).process;
  if (direct?.env) return direct;
  const toolkit = ztoolkit.getGlobal("process") as ProcessLike | undefined;
  return toolkit?.env ? toolkit : undefined;
}

function getNsIFile(): unknown {
  const ci = (globalThis as { Ci?: { nsIFile?: unknown } }).Ci;
  if (ci?.nsIFile) return ci.nsIFile;
  return (
    globalThis as {
      Components?: { interfaces?: { nsIFile?: unknown } };
    }
  ).Components?.interfaces?.nsIFile;
}

function resolveHomeDir(): string {
  const env = getProcess()?.env;
  const pathUtils = (globalThis as { PathUtils?: PathUtilsLike }).PathUtils;
  const toolkitPathUtils = ztoolkit.getGlobal("PathUtils") as
    | PathUtilsLike
    | undefined;
  const os = (globalThis as { OS?: OSLike }).OS;
  const toolkitOS = ztoolkit.getGlobal("OS") as OSLike | undefined;
  const services = (globalThis as { Services?: ServicesLike }).Services;
  const toolkitServices = ztoolkit.getGlobal("Services") as
    | ServicesLike
    | undefined;
  const home =
    env?.HOME?.trim() ||
    env?.USERPROFILE?.trim() ||
    pathUtils?.homeDir?.trim() ||
    toolkitPathUtils?.homeDir?.trim() ||
    os?.Constants?.Path?.homeDir?.trim() ||
    toolkitOS?.Constants?.Path?.homeDir?.trim() ||
    services?.dirsvc?.get?.("Home", getNsIFile())?.path?.trim() ||
    toolkitServices?.dirsvc?.get?.("Home", getNsIFile())?.path?.trim() ||
    (Zotero as unknown as { Profile?: { dir?: string } }).Profile?.dir?.trim();
  if (!home) throw new Error("Unable to resolve HOME directory for Codex auth");
  return home;
}

export function resolveCodexAuthPath(): string {
  const codexHome = getCodexHomePref() || getProcess()?.env?.CODEX_HOME?.trim();
  if (codexHome) return joinLocalPath(codexHome, "auth.json");
  return joinLocalPath(resolveHomeDir(), ".codex", "auth.json");
}

function coerceBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function defaultReadText(path: string): Promise<string> {
  const io = getIOUtils();
  if (io?.read) {
    return new TextDecoder("utf-8").decode(coerceBytes(await io.read(path)));
  }
  const osFile = getOSFile();
  if (osFile?.read) {
    return new TextDecoder("utf-8").decode(
      coerceBytes(await osFile.read(path)),
    );
  }
  throw new Error("No file API available to read Codex auth");
}

export async function resolveCodexDirectModelsUrl(
  options: CodexAuthDependencies = {},
): Promise<string> {
  // Follow newer CLI catalog versions without starting an App Server session.
  // A missing, corrupt, or old cache must not lower Direct's compatibility.
  try {
    const authPath = options.authPath || resolveCodexAuthPath();
    const cachePath = joinLocalPath(
      getLocalParentPath(authPath),
      "models_cache.json",
    );
    const cache = JSON.parse(
      await (options.readText || defaultReadText)(cachePath),
    ) as { client_version?: unknown } | null;
    const version = cache?.client_version;
    if (
      typeof version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    ) {
      return CODEX_DIRECT_MODELS_URL;
    }
    const parts = version.split(".").map(Number);
    if (!parts.every(Number.isSafeInteger)) return CODEX_DIRECT_MODELS_URL;
    const floor = CODEX_DIRECT_CLIENT_VERSION.split(".").map(Number);
    for (let index = 0; index < floor.length; index++) {
      if (parts[index] < floor[index]) return CODEX_DIRECT_MODELS_URL;
      if (parts[index] > floor[index]) break;
    }
    const url = new URL(CODEX_DIRECT_MODELS_URL);
    url.searchParams.set("client_version", version);
    return url.href;
  } catch (_error) {
    return CODEX_DIRECT_MODELS_URL;
  }
}

async function ensureParentDirectory(path: string): Promise<void> {
  const parent = getLocalParentPath(path);
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(parent, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(parent, {
      from: getLocalParentPath(parent),
      ignoreExisting: true,
    });
    return;
  }
}

async function defaultWriteText(
  path: string,
  content: string,
  beginCommit: () => void,
): Promise<void> {
  await ensureParentDirectory(path);
  const data = new TextEncoder().encode(content);
  const tmpPath = `${path}.llm-for-zotero.tmp`;
  const io = getIOUtils();
  if (io?.write) {
    beginCommit();
    await io.write(path, data, { tmpPath });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    beginCommit();
    await osFile.writeAtomic(path, data, { tmpPath });
    return;
  }
  throw new Error("No file API available to persist Codex auth");
}

function getFetch(dependencies?: CodexAuthDependencies): typeof fetch {
  if (dependencies?.fetchFn) return dependencies.fetchFn;
  const toolkitFetch = ztoolkit.getGlobal("fetch") as typeof fetch | undefined;
  if (toolkitFetch) return toolkitFetch;
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  throw new Error("fetch is unavailable for Codex auth");
}

export async function loadCodexAuthJson(
  dependencies: CodexAuthDependencies = {},
): Promise<CodexAuthJson | null> {
  const authPath = dependencies.authPath || resolveCodexAuthPath();
  try {
    const raw = await (dependencies.readText || defaultReadText)(authPath);
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as CodexAuthJson;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAuthPathKey(path: string): string {
  const normalized = path.trim().replace(/[\\/]+/g, "/");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function sessionFromAuthJson(
  authPath: string,
  auth: CodexAuthJson | null,
): CodexAuthSession {
  const token = normalizeToken(auth?.tokens?.access_token);
  const refreshToken = normalizeToken(auth?.tokens?.refresh_token);
  const accountId = normalizeToken(auth?.tokens?.account_id);
  return {
    token,
    refreshToken,
    authPath,
    ...(accountId ? { accountId } : {}),
  };
}

export function isSameCodexAuthSession(
  left: CodexAuthSession,
  right: CodexAuthSession,
): boolean {
  if (
    normalizeAuthPathKey(left.authPath) !== normalizeAuthPathKey(right.authPath)
  )
    return false;
  if (left.accountId && right.accountId && left.accountId !== right.accountId)
    return false;
  if (!right.token && !right.refreshToken) return false;
  return Boolean(
    (left.token && left.token === right.token) ||
    (left.refreshToken && left.refreshToken === right.refreshToken) ||
    (left.accountId && left.accountId === right.accountId),
  );
}

function assertSameSession(
  left: CodexAuthSession,
  right: CodexAuthSession,
): void {
  if (!isSameCodexAuthSession(left, right)) {
    throw new Error(
      "Codex login changed or signed out; please retry with the current login",
    );
  }
}

async function refreshCodexAuthSessionOnce(
  staleSession: CodexAuthSession,
  options: CodexAuthDependencies,
  task: CodexRefreshTask,
  assertOwner: () => void,
): Promise<CodexAuthSession> {
  const dependencies = { ...options, authPath: staleSession.authPath };
  const currentAuth = await loadCodexAuthJson(dependencies);
  assertOwner();
  const currentSession = sessionFromAuthJson(
    staleSession.authPath,
    currentAuth,
  );
  assertSameSession(staleSession, currentSession);
  if (currentSession.token && currentSession.token !== staleSession.token) {
    return currentSession;
  }
  const refreshToken = currentSession.refreshToken;
  if (!refreshToken) {
    throw new Error(
      "codex auth refresh token missing. Please run `codex login` to restore ~/.codex/auth.json.",
    );
  }

  const response = await getFetch(options)(CODEX_REFRESH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: task.controller.signal,
  });
  assertOwner();
  if (!response.ok) {
    const detail = await response.text();
    assertOwner();
    throw new Error(
      `Codex token refresh failed: ${response.status} ${response.statusText} - ${detail}`,
    );
  }
  const payload = (await response.json()) as unknown as Record<string, unknown>;
  assertOwner();
  const token = normalizeToken(payload.access_token);
  if (!token)
    throw new Error("Codex token refresh returned empty access token");
  const nextRefreshToken =
    normalizeToken(payload.refresh_token) || refreshToken;
  const latest = await loadCodexAuthJson(dependencies);
  assertOwner();
  const latestSession = sessionFromAuthJson(staleSession.authPath, latest);
  assertSameSession(staleSession, latestSession);
  if (
    latestSession.token !== currentSession.token ||
    latestSession.refreshToken !== currentSession.refreshToken ||
    latestSession.accountId !== currentSession.accountId
  ) {
    if (latestSession.token) return latestSession;
    throw new Error("Codex auth changed while refreshing; please retry");
  }
  const nextAuth: CodexAuthJson = {
    ...latest,
    tokens: {
      ...(latest?.tokens || {}),
      access_token: token,
      refresh_token: nextRefreshToken,
    },
    last_refresh: new Date().toISOString(),
  };
  const content = `${JSON.stringify(nextAuth, null, 2)}\n`;
  const beginCommit = () => {
    assertOwner();
    task.phase = "committing";
  };
  try {
    if (options.writeText) {
      beginCommit();
      await options.writeText(staleSession.authPath, content);
    } else await defaultWriteText(staleSession.authPath, content, beginCommit);
  } finally {
    task.phase = "settling";
  }
  assertOwner();
  return sessionFromAuthJson(staleSession.authPath, nextAuth);
}

export async function refreshCodexAuthSession(
  session: CodexAuthSession,
  options: CodexAuthDependencies & { signal?: AbortSignal } = {},
): Promise<CodexAuthSession> {
  assertNotAborted(options.signal);
  const key = normalizeAuthPathKey(session.authPath);
  let task = refreshTasksByAuthPath.get(key);
  if (
    task?.phase === "committing" &&
    (task.controller.signal.aborted ||
      !isSameCodexAuthSession(session, task.session))
  ) {
    throw new Error(
      "Codex auth save is still in progress; please retry after it finishes",
    );
  }
  if (!task || !isSameCodexAuthSession(session, task.session)) {
    const previous = task;
    const controller = new AbortController();
    const owner: CodexRefreshTask = {
      phase: "preparing",
      session,
      controller,
      promise: Promise.resolve(session),
    };
    const assertOwner = () => {
      assertNotAborted(controller.signal);
      if (refreshTasksByAuthPath.get(key) !== owner) {
        throw new Error("Codex auth refresh superseded; please retry");
      }
    };
    if (!previous) refreshTasksByAuthPath.set(key, owner);
    const timeout = setTimeout(() => {
      if (
        refreshTasksByAuthPath.get(key) === owner &&
        owner.phase !== "committing"
      ) {
        refreshTasksByAuthPath.delete(key);
      }
      controller.abort(new Error("Codex auth refresh timed out; please retry"));
    }, options.refreshTimeoutMs ?? 30_000);
    const work = Promise.resolve()
      .then(async () => {
        if (previous) {
          const currentAuth = await loadCodexAuthJson({
            ...options,
            authPath: session.authPath,
          });
          assertNotAborted(controller.signal);
          assertSameSession(
            session,
            sessionFromAuthJson(session.authPath, currentAuth),
          );
          const active = refreshTasksByAuthPath.get(key);
          if (
            active?.phase === "committing" &&
            (active.controller.signal.aborted ||
              !isSameCodexAuthSession(session, active.session))
          ) {
            throw new Error(
              "Codex auth save is still in progress; please retry after it finishes",
            );
          }
          if (active && isSameCodexAuthSession(session, active.session)) {
            return waitForCodexTask(active.promise, controller.signal);
          }
          refreshTasksByAuthPath.set(key, owner);
          active?.controller.abort(
            new Error(
              "Codex login changed; please retry with the current login",
            ),
          );
        }
        assertOwner();
        return refreshCodexAuthSessionOnce(
          session,
          options,
          owner,
          assertOwner,
        );
      })
      .finally(() => {
        if (refreshTasksByAuthPath.get(key) === owner)
          refreshTasksByAuthPath.delete(key);
      });
    owner.promise = waitForCodexTask(work, controller.signal).finally(() =>
      clearTimeout(timeout),
    );
    task = owner;
  }
  const result = await waitForCodexTask(task.promise, options.signal);
  assertNotAborted(options.signal);
  return result;
}

export async function resolveCodexAuthSession(
  options: CodexAuthDependencies & { signal?: AbortSignal } = {},
): Promise<CodexAuthSession> {
  assertNotAborted(options.signal);
  const authPath = options.authPath || resolveCodexAuthPath();
  const auth = await waitForCodexTask(
    loadCodexAuthJson({ ...options, authPath }),
    options.signal,
  );
  assertNotAborted(options.signal);
  const session = sessionFromAuthJson(authPath, auth);
  if (session.token) return session;
  if (session.refreshToken) return refreshCodexAuthSession(session, options);
  throw new Error(
    "codex auth token not found. Please run `codex login` and ensure ~/.codex/auth.json is available.",
  );
}

export function resetCodexAuthRefreshStateForTests(): void {
  for (const [key, task] of refreshTasksByAuthPath) {
    if (task.phase !== "committing") refreshTasksByAuthPath.delete(key);
    task.controller.abort(new Error("Codex auth refresh reset"));
  }
}

export function buildCodexAuthHeaders(
  session: Pick<CodexAuthSession, "token" | "accountId">,
  base: Record<string, string> = {},
): Record<string, string> {
  return {
    ...base,
    Authorization: `Bearer ${session.token}`,
    ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
  };
}

export function isTrustedCodexBackendUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      (url.pathname === "/backend-api/codex/models" ||
        url.pathname === "/backend-api/codex/responses")
    );
  } catch (_error) {
    return false;
  }
}

export async function fetchWithCodexAuth(
  url: string,
  init: RequestInit = {},
  options: CodexAuthDependencies & {
    signal?: AbortSignal;
    session?: CodexAuthSession;
  } = {},
): Promise<Response> {
  if (!isTrustedCodexBackendUrl(url)) {
    throw new Error("Refusing to send Codex credentials to an untrusted URL");
  }
  const signal = options.signal || init.signal;
  assertNotAborted(signal);
  const fetchFn = getFetch(options);
  const original =
    options.session ||
    (await resolveCodexAuthSession({
      ...options,
      signal: signal || undefined,
    }));
  assertNotAborted(signal);
  const send = (current: CodexAuthSession) => {
    assertNotAborted(signal);
    return waitForCodexTask(
      fetchFn(url, {
        ...init,
        headers: buildCodexAuthHeaders(current, {
          ...Object.fromEntries(new Headers(init.headers).entries()),
        }),
        signal,
      }),
      signal,
    );
  };
  let response = await send(original);
  assertNotAborted(signal);
  if (response.status === 401 && original.refreshToken) {
    const session = await refreshCodexAuthSession(original, {
      ...options,
      signal: signal || undefined,
    });
    assertNotAborted(signal);
    response = await send(session);
    assertNotAborted(signal);
  }
  return response;
}
