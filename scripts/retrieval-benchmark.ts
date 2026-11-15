/**
 * Local retrieval benchmark for real MinerU caches.
 *
 * Runs the shipped retrieval path (`ensurePDFTextCached` →
 * `buildPaperRetrievalCandidates`) against the MinerU cache of a real Zotero
 * data directory, outside Zotero, and prints what the retriever sees: the
 * chunk inventory with section labels, the structure metrics from
 * `measureCorpus`, and — with `--query` — the top-8 table with the reason each
 * chunk scored where it did.
 *
 * Usage (from the repository root):
 *
 *   npx tsx scripts/retrieval-benchmark.ts --data-dir <zotero data dir> --ids 4458,1187
 *   npx tsx scripts/retrieval-benchmark.ts --data-dir <dir> --ids 4458 \
 *       --query "why is the pressure gradient singular at the contact line" \
 *       --variants "pressure gradient singular|kinematic condition"
 *   npx tsx scripts/retrieval-benchmark.ts --data-dir <dir> --ids 4458 \
 *       --embeddings --prefs "<profile>/prefs.js"
 *
 * Embeddings are off unless `--embeddings` is passed; the embedding provider
 * and key are then read from the `--prefs` file. Secret values are never
 * printed — only whether a key was found.
 *
 * The data directory is treated as read-only: writes made by the plugin code
 * (for example a rebuilt `manifest.json`) are captured in a temporary overlay
 * so a benchmark run can never modify the real cache.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensurePDFTextCached,
  buildPaperRetrievalCandidates,
} from "../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import { checkEmbeddingAvailability } from "../src/utils/llmClient";
import {
  listMarkdownHeadings,
  measureCorpus,
  mockPdfAttachment,
  rankChunksForQuery,
  type RankedChunk,
} from "../test/helpers/retrievalCorpus";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import type { PdfContext } from "../src/services/paperContent/types";

const PREF_PREFIX = "extensions.zotero.llmforzotero.";

type Options = {
  dataDir: string;
  ids: number[];
  query?: string;
  variants: string[];
  embeddings: boolean;
  prefsPath?: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dataDir: "",
    ids: [],
    variants: [],
    embeddings: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--data-dir":
        options.dataDir = value();
        break;
      case "--ids":
        options.ids = value()
          .split(",")
          .map((entry) => Number(entry.trim()))
          .filter((entry) => Number.isFinite(entry));
        break;
      case "--query":
        options.query = value();
        break;
      case "--variants":
        options.variants = value()
          .split("|")
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      case "--embeddings":
        options.embeddings = true;
        break;
      case "--prefs":
        options.prefsPath = value();
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.dataDir) throw new Error("--data-dir is required");
  if (!options.ids.length) throw new Error("--ids is required");
  if (options.embeddings && !options.prefsPath) {
    throw new Error("--embeddings requires --prefs <prefs.js>");
  }
  return options;
}

function printUsage(): void {
  console.log(
    [
      "Usage: npx tsx scripts/retrieval-benchmark.ts --data-dir <dir> --ids 4458[,1187]",
      '                 [--query "<text>"] [--variants "a|b"]',
      "                 [--embeddings --prefs <prefs.js>]",
    ].join("\n"),
  );
}

// ── Preferences (read-only, never printed) ───────────────────────────────────

function readPrefFromFile(contents: string, key: string): unknown {
  const escaped = (PREF_PREFIX + key).replace(/\./g, "\\.");
  const match = contents.match(
    new RegExp(
      `user_pref\\("${escaped}",\\s*("(?:\\\\.|[^"\\\\])*"|true|false|-?\\d+)\\);`,
    ),
  );
  if (!match) return undefined;
  const raw = match[1];
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ── Filesystem-backed IOUtils with a copy-on-write overlay ───────────────────

/**
 * Install the read-only filesystem overlay and the mocked `Zotero`,
 * `IOUtils`, `PathUtils` and `ztoolkit` globals for `dataDir`. Every write the
 * plugin code makes lands in a temporary overlay directory, never in
 * `dataDir`. Shared with `library-index-benchmark.ts`.
 */
export function installBenchmarkGlobals(
  dataDir: string,
  settings: { embeddings?: boolean; prefsPath?: string } = {},
): {
  overlayDir: string;
  devPref: (key: string) => unknown;
} {
  const options = {
    dataDir,
    embeddings: settings.embeddings === true,
    prefsPath: settings.prefsPath,
  };
  const overlayDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "retrieval-benchmark-"),
  );
  const deleted = new Set<string>();
  const overlayPathFor = (target: string) =>
    path.join(overlayDir, path.resolve(target).replace(/^\/+/, ""));
  const resolveRead = (target: string): string | null => {
    const overlaid = overlayPathFor(target);
    if (fs.existsSync(overlaid)) return overlaid;
    if (deleted.has(path.resolve(target))) return null;
    return fs.existsSync(target) ? target : null;
  };

  const io = {
    exists: async (target: string) => Boolean(resolveRead(target)),
    read: async (target: string) => {
      const resolved = resolveRead(target);
      if (!resolved) throw new Error(`Missing file: ${target}`);
      return new Uint8Array(fs.readFileSync(resolved));
    },
    write: async (target: string, data: Uint8Array) => {
      const overlaid = overlayPathFor(target);
      fs.mkdirSync(path.dirname(overlaid), { recursive: true });
      fs.writeFileSync(overlaid, data);
      deleted.delete(path.resolve(target));
      return data.length;
    },
    makeDirectory: async (target: string) => {
      fs.mkdirSync(overlayPathFor(target), { recursive: true });
    },
    remove: async (target: string) => {
      deleted.add(path.resolve(target));
      fs.rmSync(overlayPathFor(target), { recursive: true, force: true });
    },
    getChildren: async (target: string) => {
      const names = new Set<string>();
      for (const dir of [target, overlayPathFor(target)]) {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
        for (const name of fs.readdirSync(dir)) names.add(name);
      }
      return [...names]
        .map((name) => path.join(target, name))
        .filter((child) => !deleted.has(path.resolve(child)));
    },
    stat: async (target: string) => {
      const resolved = resolveRead(target);
      if (!resolved) throw new Error(`Missing file: ${target}`);
      const stats = fs.statSync(resolved);
      return {
        type: stats.isDirectory() ? "directory" : "regular",
        size: stats.size,
      };
    },
  };

  const prefsContents = options.prefsPath
    ? fs.readFileSync(options.prefsPath, "utf8")
    : "";
  const devPref = (key: string) =>
    prefsContents ? readPrefFromFile(prefsContents, key) : undefined;

  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: options.dataDir },
    Profile: { dir: path.join(overlayDir, "profile") },
    Prefs: {
      get: (key: string) => {
        const short = key.startsWith(PREF_PREFIX)
          ? key.slice(PREF_PREFIX.length)
          : key;
        switch (short) {
          case "mineruEnabled":
            return true;
          case "mineruSyncEnabled":
            return false;
          case "enableSemanticSearch":
            return options.embeddings;
          case "embeddingProvider":
          case "embeddingApiBase":
          case "embeddingApiKey":
          case "embeddingModel":
          case "modelProviderGroups":
            return devPref(short);
          default:
            return undefined;
        }
      },
      set: () => {},
    },
    Items: {
      get: (id: number) =>
        id === 100
          ? { getField: (field: string) => (field === "title" ? "Paper" : "") }
          : null,
    },
    PDFWorker: {
      getFullText: async () => ({ text: "" }),
    },
  };
  (globalThis as unknown as { IOUtils: typeof io }).IOUtils = io;
  (globalThis as unknown as { PathUtils: unknown }).PathUtils = {
    join: (...parts: string[]) => path.join(...parts),
    parent: (target: string) => path.dirname(target),
    filename: (target: string) => path.basename(target),
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    log: () => {},
    getGlobal: (name: string) => {
      if (name === "fetch") return globalThis.fetch.bind(globalThis);
      if (name === "AbortController") return AbortController;
      if (name === "IOUtils") return io;
      return (globalThis as unknown as Record<string, unknown>)[name];
    },
  };
  return { overlayDir, devPref };
}

/** MinerU caches keep `full.md` at the item root, sometimes one level down. */
function findFullMarkdown(itemDir: string): string | null {
  const direct = path.join(itemDir, "full.md");
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(itemDir)) return null;
  for (const entry of fs.readdirSync(itemDir)) {
    const nested = path.join(itemDir, entry, "full.md");
    if (fs.existsSync(nested)) return nested;
  }
  return null;
}

function paperRefFor(attachmentId: number, title: string): PaperContextRef {
  return {
    itemId: 100,
    contextItemId: attachmentId,
    title,
    firstCreator: "Benchmark",
    year: "2026",
  };
}

// ── Section paths derived from the markdown itself ───────────────────────────

type HeadingWithPath = {
  offset: number;
  level: number;
  heading: string;
  path: string;
};

function buildHeadingPaths(markdown: string): HeadingWithPath[] {
  const stack: { level: number; heading: string }[] = [];
  return listMarkdownHeadings(markdown).map((entry) => {
    while (stack.length && stack[stack.length - 1].level >= entry.level) {
      stack.pop();
    }
    stack.push({ level: entry.level, heading: entry.heading });
    return { ...entry, path: stack.map((item) => item.heading).join(" › ") };
  });
}

function sectionPathForChunk(params: {
  chunkText: string;
  sourceStart?: number;
  markdown: string;
  headings: HeadingWithPath[];
}): string {
  const probe = params.chunkText.slice(0, 120);
  const located = probe ? params.markdown.indexOf(probe) : -1;
  const offset = located >= 0 ? located : (params.sourceStart ?? -1);
  if (offset < 0) return "?";
  let current = "(preamble)";
  for (const heading of params.headings) {
    if (heading.offset <= offset) current = heading.path;
    else break;
  }
  return current;
}

// ── Printing ────────────────────────────────────────────────────────────────

function truncate(value: string, width: number): string {
  return value.length <= width
    ? value.padEnd(width)
    : `${value.slice(0, width - 1)}…`;
}

/** Keep the deepest part of a section path, which is the informative end. */
function truncatePathTail(value: string, width: number): string {
  return value.length <= width
    ? value.padEnd(width)
    : `…${value.slice(value.length - width + 1)}`;
}

function printInventory(
  ctx: PdfContext,
  markdown: string,
  headings: HeadingWithPath[],
): void {
  console.log("");
  console.log("Chunk inventory");
  console.log(
    `${"idx".padStart(4)}  ${"start-end".padEnd(15)} ${"len".padStart(5)}  ${truncate("kind", 14)} ${truncate("sectionLabel", 24)} sectionPath (from markdown)`,
  );
  for (const meta of ctx.chunkMeta) {
    const range = `${meta.sourceStart ?? "?"}-${meta.sourceEnd ?? "?"}`;
    console.log(
      `${String(meta.chunkIndex).padStart(4)}  ${range.padEnd(15)} ${String(meta.text.length).padStart(5)}  ${truncate(String(meta.chunkKind), 14)} ${truncate(meta.sectionLabel || "-", 24)} ${sectionPathForChunk(
        {
          chunkText: meta.text,
          sourceStart: meta.sourceStart,
          markdown,
          headings,
        },
      )}`,
    );
  }
}

function formatPriorShift(why: RankedChunk["why"]): string {
  if (!why) return "n/a";
  if (why.demoted) return "demoted";
  const shift = why.priorShift;
  return shift > 0 ? `+${shift}` : String(shift);
}

function explainRow(row: RankedChunk): string {
  const parts = [
    `bm25 ${row.bm25Score.toFixed(3)}`,
    `rank ${row.why ? row.why.bm25Rank : "?"}`,
    `fused ${row.hybridScore.toFixed(4)}`,
    `prior ${formatPriorShift(row.why)} (${row.chunkKind || "-"}/${row.why?.kindSource || "-"})`,
  ];
  if (row.why?.embeddingRank) parts.push(`embedRank ${row.why.embeddingRank}`);
  if (row.why?.structureRule) parts.push(`rule ${row.why.structureRule}`);
  if (row.embeddingScore) parts.push(`cosine ${row.embeddingScore.toFixed(3)}`);
  if (row.matchedQueryVariant) {
    parts.push(`matched "${truncate(row.matchedQueryVariant, 28).trim()}"`);
  }
  return parts.join("; ");
}

function printQueryTable(
  rows: RankedChunk[],
  markdown: string,
  headings: HeadingWithPath[],
  chunks: string[],
): void {
  console.log(
    `${"rank".padStart(4)} ${"chunk".padStart(5)} ${"score".padStart(8)}  ${truncate("label", 18)} ${truncatePathTail("sectionPath", 40)} why`,
  );
  for (const row of rows) {
    console.log(
      `${String(row.rank).padStart(4)} ${String(row.chunkIndex).padStart(5)} ${row.evidenceScore.toFixed(4).padStart(8)}  ${truncate(row.sectionLabel || "-", 18)} ${truncatePathTail(
        sectionPathForChunk({
          chunkText: chunks[row.chunkIndex] || "",
          sourceStart: row.sourceStart,
          markdown,
          headings,
        }),
        40,
      )} ${explainRow(row)}`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { overlayDir, devPref } = installBenchmarkGlobals(options.dataDir, {
    embeddings: options.embeddings,
    prefsPath: options.prefsPath,
  });

  console.log(
    `data dir: ${options.dataDir} (read-only; writes go to ${overlayDir})`,
  );
  console.log(
    `embeddings: ${options.embeddings ? `on (prefs: ${options.prefsPath})` : "off"}`,
  );
  if (options.embeddings) {
    // Provider, model and endpoint host only — never the key itself.
    let endpoint = "(unset)";
    try {
      const url = new URL(String(devPref("embeddingApiBase") || ""));
      endpoint = `${url.host}${url.pathname}`;
    } catch {
      endpoint = "(unparsable)";
    }
    console.log(
      `embedding config: provider=${String(devPref("embeddingProvider") || "(unset)")} model=${String(devPref("embeddingModel") || "(default)")} endpoint=${endpoint} usable=${checkEmbeddingAvailability()}`,
    );
  }

  for (const id of options.ids) {
    const itemDir = path.join(
      options.dataDir,
      "llm-for-zotero-mineru",
      String(id),
    );
    console.log("");
    console.log(`=== id ${id} ===`);
    const mdPath = findFullMarkdown(itemDir);
    if (!mdPath) {
      console.log(`no MinerU full.md under ${itemDir} — skipped`);
      continue;
    }
    const markdown = fs.readFileSync(mdPath, "utf8");
    const headings = buildHeadingPaths(markdown);

    pdfTextCache.clear();
    await ensurePDFTextCached(mockPdfAttachment(id));
    const ctx = pdfTextCache.get(id);
    if (!ctx) {
      console.log("no PdfContext built — skipped");
      continue;
    }
    const paperRef = paperRefFor(id, ctx.title || `Paper ${id}`);
    console.log(
      `title: ${ctx.title || "(none)"}  source: ${ctx.sourceType}  chunks: ${ctx.chunks.length}  fullLength: ${ctx.fullLength}  headings: ${headings.length}`,
    );

    printInventory(ctx, markdown, headings);

    const metrics = await measureCorpus(ctx, paperRef, {
      fullMarkdown: markdown,
    });
    console.log("");
    console.log("Structure metrics");
    console.log(`  labelCoverage        ${metrics.labelCoverage.toFixed(3)}`);
    console.log(
      `  labelAccuracy        ${metrics.labelAccuracy === null ? "n/a" : metrics.labelAccuracy.toFixed(3)}`,
    );
    console.log(
      `  selfRetrievalTop1    ${metrics.selfRetrievalTop1.toFixed(3)} (probes: ${metrics.probeCount})`,
    );
    console.log(
      `  selfRetrievalTop3    ${metrics.selfRetrievalTop3.toFixed(3)}`,
    );
    console.log(
      `  conclusionFirstCount ${metrics.conclusionFirstCount} of ${metrics.probeCount} probes`,
    );
    console.log(
      `  nonsenseQuery top-8  [${metrics.nonsenseQueryChunkIndexes.join(", ")}]`,
    );
    if (options.embeddings) {
      console.log(
        `  embeddings           ${ctx.embeddings?.length ?? 0} chunk vectors; failure: ${ctx.embeddingFailureKey ? "yes" : "no"}`,
      );
    }

    if (options.query) {
      console.log("");
      console.log(`Query: ${JSON.stringify(options.query)}`);
      if (options.variants.length) {
        console.log(`Variants: ${options.variants.join(" | ")}`);
      }
      const rows = await rankChunksForQuery({
        paperRef,
        ctx,
        query: options.query,
        variants: options.variants,
        topK: 8,
      });
      printQueryTable(rows, markdown, headings, ctx.chunks);
    }

    console.log("");
    console.log(
      `JSON ${JSON.stringify({ id, chunks: ctx.chunks.length, sourceType: ctx.sourceType, ...metrics })}`,
    );
  }
}

// Run only when invoked directly, so a sibling script can import the globals.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
