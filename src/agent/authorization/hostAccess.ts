import type { AgentExecutionContext, AgentInvocationPlan } from "../types";
import {
  getLocalParentPath,
  isAbsoluteLocalPath,
  joinLocalPath,
} from "../../utils/localPath";

export type ResolvedHostAccess = Readonly<{
  readFiles: readonly string[];
  writeFiles: readonly string[];
  readDirectories: readonly string[];
  writeDirectories: readonly string[];
  hostCommandExecution: boolean;
}>;

export type HostAccessDecision =
  | { kind: "allow" }
  | { kind: "expand"; reason: string; targets: readonly string[] }
  | { kind: "block"; reason: string; targets: readonly string[] };

function windowsHost(): boolean {
  const isWin = (
    globalThis as typeof globalThis & { Zotero?: { isWin?: unknown } }
  ).Zotero?.isWin;
  if (typeof isWin === "boolean") return isWin;
  return (
    (globalThis as typeof globalThis & { process?: { platform?: string } })
      .process?.platform === "win32"
  );
}

/** Lexical normalization used after an optional native realpath resolution. */
function normalizeLocalPath(value: string): string | null {
  if (!isAbsoluteLocalPath(value)) return null;
  const raw = value.replace(/\\/g, "/");
  const drive = raw.match(/^([A-Za-z]:)\//)?.[1];
  const unc = !drive && raw.startsWith("//");
  const prefix = drive ? `${drive}/` : unc ? "//" : "/";
  const body = drive ? raw.slice(3) : raw.replace(/^\/+/, "");
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const normalized = `${prefix}${segments.join("/")}`;
  return windowsHost() ? normalized.toLowerCase() : normalized;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || "";
}

type NativeLocalFile = {
  path: string;
  leafName: string;
  parent: NativeLocalFile | null;
  initWithPath: (path: string) => void;
  append: (name: string) => void;
  exists: () => boolean;
  isSymlink?: () => boolean;
  target?: string;
};

function createNativeLocalFile(path: string): NativeLocalFile | null {
  try {
    const components = (
      globalThis as typeof globalThis & {
        Components?: {
          classes?: Record<
            string,
            { createInstance?: (type: unknown) => NativeLocalFile }
          >;
          interfaces?: { nsIFile?: unknown };
        };
      }
    ).Components;
    const file = components?.classes?.[
      "@mozilla.org/file/local;1"
    ]?.createInstance?.(components.interfaces?.nsIFile);
    if (!file) return null;
    file.initWithPath(path);
    return file;
  } catch {
    return null;
  }
}

function resolveExistingNativePath(
  path: string,
  followedLinks = new Set<string>(),
  depth = 0,
): string | null {
  const lexical = normalizeLocalPath(path);
  if (!lexical || depth > 128) return null;
  const file = createNativeLocalFile(path);
  if (!file?.exists()) return null;
  const parent = file.parent;
  if (!parent) return normalizeLocalPath(file.path);
  const resolvedParent = resolveExistingNativePath(
    parent.path,
    followedLinks,
    depth + 1,
  );
  if (!resolvedParent) return null;
  const resolvedFile = createNativeLocalFile(resolvedParent);
  if (!resolvedFile) return null;
  resolvedFile.append(file.leafName);
  try {
    if (resolvedFile.isSymlink?.()) {
      const target = resolvedFile.target;
      const linkPath = normalizeLocalPath(resolvedFile.path);
      if (
        typeof target !== "string" ||
        !linkPath ||
        followedLinks.has(linkPath)
      )
        return null;
      const nextLinks = new Set(followedLinks);
      nextLinks.add(linkPath);
      return resolveExistingNativePath(
        isAbsoluteLocalPath(target)
          ? target
          : joinLocalPath(resolvedParent, target),
        nextLinks,
        depth + 1,
      );
    }
  } catch {
    return null;
  }
  return normalizeLocalPath(resolvedFile.path);
}

/**
 * Resolve symlinks for existing targets and for the nearest existing parent
 * of a new target. Native nsIFile components provide the Gecko path identity;
 * Windows reparse points that cannot be resolved safely are rejected.
 */
async function resolveAccessPath(value: string): Promise<string | null> {
  const lexical = normalizeLocalPath(value);
  if (!lexical) return null;
  const io = (
    globalThis as typeof globalThis & {
      IOUtils?: {
        exists?: (path: string) => Promise<boolean>;
        realPath?: (path: string) => Promise<string>;
        stat?: (path: string) => Promise<{ type?: string }>;
      };
    }
  ).IOUtils;
  let cursor = value;
  const suffix: string[] = [];
  try {
    while (cursor) {
      const exists =
        typeof io?.exists === "function"
          ? await io.exists(cursor)
          : createNativeLocalFile(cursor)?.exists();
      if (exists !== false) break;
      const parent = getLocalParentPath(cursor);
      if (!parent || parent === cursor) return null;
      suffix.unshift(fileName(cursor));
      cursor = parent;
    }
    if (windowsHost() && typeof io?.stat === "function") {
      let component = cursor;
      while (component) {
        if ((await io.stat(component)).type === "other") return null;
        const parent = getLocalParentPath(component);
        if (!parent || parent === component) break;
        component = parent;
      }
    }
    const nativePath = resolveExistingNativePath(cursor);
    const nodeRuntime = Boolean(
      (
        globalThis as typeof globalThis & {
          process?: { versions?: { node?: string } };
        }
      ).process?.versions?.node,
    );
    const base =
      typeof io?.realPath === "function"
        ? await io.realPath(cursor)
        : nativePath || (nodeRuntime ? normalizeLocalPath(cursor) : null);
    if (!base) return null;
    return normalizeLocalPath(
      [base.replace(/[\\/]+$/g, ""), ...suffix].join("/"),
    );
  } catch {
    return null;
  }
}

async function resolvedUnique(paths: readonly string[]): Promise<string[]> {
  const values = await Promise.all(paths.map(resolveAccessPath));
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function inside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

export function resolveConfiguredHostAccess(
  executionContext: AgentExecutionContext,
): ResolvedHostAccess {
  const configured = executionContext.configuredAccess;
  const legacyRoots = configured.outputDirectories || [];
  return {
    readFiles: configured.fileAccess?.readFiles || [],
    writeFiles: configured.fileAccess?.writeFiles || [],
    readDirectories: configured.fileAccess?.readDirectories || legacyRoots,
    writeDirectories: configured.fileAccess?.writeDirectories || legacyRoots,
    hostCommandExecution: configured.hostCommandExecution === true,
  };
}

export async function evaluateHostAccess(params: {
  toolName: string;
  plan: AgentInvocationPlan;
  executionContext: AgentExecutionContext;
}): Promise<HostAccessDecision> {
  const access = resolveConfiguredHostAccess(params.executionContext);
  if (params.toolName === "run_command") {
    return access.hostCommandExecution
      ? { kind: "allow" }
      : {
          kind: "expand",
          targets: [],
          reason:
            "Host command execution is not enabled for this caller. Approve this exact command expansion.",
        };
  }
  if (params.toolName !== "file_io") return { kind: "allow" };
  if (
    params.executionContext.configuredAccess.unrestrictedFileAccess === true
  ) {
    return params.plan.targets.every(isAbsoluteLocalPath)
      ? { kind: "allow" }
      : {
          kind: "block",
          targets: params.plan.targets,
          reason: "File targets must be absolute local paths.",
        };
  }
  const resolvedTargets = await Promise.all(
    params.plan.targets.map(resolveAccessPath),
  );
  if (resolvedTargets.some((target) => !target)) {
    return {
      kind: "block",
      targets: params.plan.targets,
      reason:
        "File access was refused because every target must be an absolute, canonically resolvable local path.",
    };
  }
  const targetPaths = resolvedTargets as string[];
  const [readFiles, writeFiles, readDirectories, writeDirectories] =
    await Promise.all([
      resolvedUnique(access.readFiles),
      resolvedUnique(access.writeFiles),
      resolvedUnique(access.readDirectories),
      resolvedUnique(access.writeDirectories),
    ]);
  const write = params.plan.impact !== "read_only";
  const hasWriteAccess = (target: string) =>
    writeFiles.includes(target) ||
    writeDirectories.some((directory) => inside(target, directory));
  const outside = targetPaths.filter((target) =>
    write
      ? !hasWriteAccess(target)
      : !readFiles.includes(target) &&
        !readDirectories.some((directory) => inside(target, directory)),
  );
  if (write) {
    const resolvedTemporaryPaths = await Promise.all(
      params.plan.targets.map((target) => resolveAccessPath(`${target}.tmp`)),
    );
    if (resolvedTemporaryPaths.some((target) => !target)) {
      return {
        kind: "block",
        targets: params.plan.targets.map((target) => `${target}.tmp`),
        reason:
          "File access was refused because every managed temporary destination must be canonically resolvable.",
      };
    }
    for (const [index, temporaryPath] of (
      resolvedTemporaryPaths as string[]
    ).entries()) {
      const targetPath = targetPaths[index];
      if (!hasWriteAccess(targetPath)) continue;
      const temporaryAllowed =
        hasWriteAccess(temporaryPath) ||
        (writeFiles.includes(targetPath) &&
          getLocalParentPath(temporaryPath) === getLocalParentPath(targetPath));
      if (!temporaryAllowed) outside.push(temporaryPath);
    }
  }
  const uniqueOutside = [...new Set(outside)];
  return uniqueOutside.length
    ? {
        kind: "expand",
        targets: uniqueOutside,
        reason: `Host ${write ? "write" : "read"} access is not granted for: ${uniqueOutside.join(", ")}`,
      }
    : { kind: "allow" };
}
