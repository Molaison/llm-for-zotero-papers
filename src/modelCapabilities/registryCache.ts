import { joinLocalPath } from "../utils/localPath";
import {
  isRecord,
  MODEL_CAPABILITY_REGISTRY_MAX_BYTES,
  validateRegistry,
} from "./registry";
import type { ModelCapabilityRegistry } from "./types";

const LEGACY_REGISTRY_PREF =
  "extensions.zotero.llmforzotero.modelCapabilitiesRegistry";
const LEGACY_TIMESTAMP_PREF =
  "extensions.zotero.llmforzotero.modelCapabilitiesRegistryFetchedAt";
// Allow a little space for the cache envelope around the bounded registry.
const CACHE_MAX_BYTES = MODEL_CAPABILITY_REGISTRY_MAX_BYTES + 1024;

export type ModelCapabilityRegistryCache = {
  schemaVersion: 1;
  registry: ModelCapabilityRegistry;
  fetchedAt: number;
};

type CacheHost = {
  Zotero?: {
    Profile?: { dir?: string };
    Prefs?: {
      get?: (key: string, global?: boolean) => unknown;
      clear?: (key: string, global?: boolean) => void;
    };
  };
  IOUtils?: {
    read: (path: string, options: { maxBytes: number }) => Promise<Uint8Array>;
    write: (
      path: string,
      bytes: Uint8Array,
      options: { tmpPath: string; flush: boolean },
    ) => Promise<unknown>;
  };
};

function host(): CacheHost {
  return globalThis as unknown as CacheHost;
}

export function getModelCapabilityRegistryCachePath(): string {
  const profileDir = host().Zotero?.Profile?.dir;
  if (!profileDir) throw new Error("Zotero profile directory is unavailable");
  return joinLocalPath(profileDir, "llm-for-zotero-model-capabilities.json");
}

function normalizeFetchedAt(value: unknown, now: number): number {
  const timestamp = Number(value);
  // Corrupt/future timestamps must not suppress refresh. Legacy 32-bit
  // timestamps are either invalid here or old enough to trigger a refresh.
  return Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= now
    ? timestamp
    : 0;
}

function clearLegacyPreferences(): void {
  for (const key of [LEGACY_REGISTRY_PREF, LEGACY_TIMESTAMP_PREF]) {
    try {
      host().Zotero?.Prefs?.clear?.(key, true);
    } catch {
      // The file is already durable; retry cleanup on the next load/save.
    }
  }
}

function readLegacyCache(now: number): ModelCapabilityRegistryCache | null {
  try {
    const prefs = host().Zotero?.Prefs;
    const raw = prefs?.get?.(LEGACY_REGISTRY_PREF, true);
    if (typeof raw !== "string" || raw.length > CACHE_MAX_BYTES) return null;
    const registry = validateRegistry(JSON.parse(raw));
    if (!registry) return null;
    return {
      schemaVersion: 1,
      registry,
      fetchedAt: normalizeFetchedAt(
        prefs?.get?.(LEGACY_TIMESTAMP_PREF, true),
        now,
      ),
    };
  } catch {
    return null;
  }
}

/** A failed save leaves both the previous file and legacy preferences intact. */
export async function writeModelCapabilityRegistryCache(
  cache: ModelCapabilityRegistryCache,
): Promise<boolean> {
  try {
    const io = host().IOUtils;
    if (!io?.write) return false;
    const path = getModelCapabilityRegistryCachePath();
    const bytes = new TextEncoder().encode(JSON.stringify(cache));
    if (bytes.byteLength > CACHE_MAX_BYTES) return false;
    await io.write(path, bytes, { tmpPath: `${path}.tmp`, flush: true });
    clearLegacyPreferences();
    return true;
  } catch {
    // Disk persistence is optional; keep using the valid in-memory registry.
    return false;
  }
}

export async function readModelCapabilityRegistryCache(
  now: number,
): Promise<ModelCapabilityRegistryCache | null> {
  let cached: ModelCapabilityRegistryCache | null = null;
  try {
    const bytes = await host().IOUtils?.read(
      getModelCapabilityRegistryCachePath(),
      { maxBytes: CACHE_MAX_BYTES + 1 },
    );
    if (bytes && bytes.byteLength <= CACHE_MAX_BYTES) {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (isRecord(value) && value.schemaVersion === 1) {
        const registry = validateRegistry(value.registry);
        if (registry) {
          cached = {
            schemaVersion: 1,
            registry,
            fetchedAt: normalizeFetchedAt(value.fetchedAt, now),
          };
        }
      }
    }
  } catch {
    // Missing, unreadable or corrupt caches fall back to legacy/bundled data.
  }
  const legacy = readLegacyCache(now);
  if (
    legacy &&
    (!cached || legacy.registry.revision > cached.registry.revision)
  ) {
    await writeModelCapabilityRegistryCache(legacy);
    return legacy;
  }
  if (cached) clearLegacyPreferences();
  return cached;
}
