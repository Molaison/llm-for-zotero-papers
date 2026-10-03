// Run with: MINERU_TEST_URL=http://127.0.0.1:8000 npx tsx scripts/test-mineru-local-live.ts paper.pdf flash
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parsePdfWithMineruLocal } from "../src/utils/mineruClient";
import { detectMineruLocalService } from "../src/utils/mineruLocalClient";
import {
  MINERU_LOCAL_TIERS,
  type MineruLocalTier,
} from "../src/utils/mineruConfig";
const [pdf, tier = "auto"] = process.argv.slice(2);
const base = process.env.MINERU_TEST_URL;
if (!pdf || !base || !MINERU_LOCAL_TIERS.includes(tier as MineruLocalTier))
  throw new Error(
    "Set MINERU_TEST_URL and pass a PDF path and optional tier (auto/flash/basic/standard/advanced).",
  );
(globalThis as any).ztoolkit = {
  getGlobal: (key: string) => (globalThis as any)[key],
  log: () => {},
};
(globalThis as any).Zotero = { Prefs: { get: () => undefined } };
(globalThis as any).IOUtils = { read: readFile };
const apiKey = process.env.MINERU_TEST_API_KEY || "";
const service = await detectMineruLocalService(base, apiKey);
const result = await parsePdfWithMineruLocal(
  pdf,
  base,
  "pipeline",
  console.log,
  undefined,
  false,
  {
    tier: tier as MineruLocalTier,
    effort: "medium",
    imageAnalysis: true,
    serverUrl: "",
    apiKey,
  },
);
if (!result?.mdContent.trim()) throw new Error("No Markdown returned");
const contentFile = result.files.find((file) =>
  /(^|\/)content_list.json$/.test(file.relativePath),
);
if (!contentFile) throw new Error("No content list returned");
const content = JSON.parse(new TextDecoder().decode(contentFile.data));
if (!Array.isArray(content)) throw new Error("Invalid content list");
const evidence = {
  service,
  characters: result.mdContent.length,
  files: result.files.map((file) => file.relativePath),
  pages: [...new Set(content.map((entry) => entry.page_idx))],
};
await mkdir(".scaffold/mineru-validation", { recursive: true });
await writeFile(
  ".scaffold/mineru-validation/live-result.json",
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence));
