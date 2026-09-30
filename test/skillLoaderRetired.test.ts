import { readFileSync } from "node:fs";
import { assert } from "chai";
import { BUILTIN_SKILL_FILES, buildSkillInventory } from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";
import { hashSkillForUpgrade } from "../src/agent/skills/managedBlock";
import {
  getCanonicalSkillFilePath,
  getCanonicalUserSkillsDir,
} from "../src/agent/skills/nativeSkillPaths";
import { initUserSkills, loadUserSkills } from "../src/agent/skills/userSkills";
import { setAppLogSinkForTests } from "../src/core/logging";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
  IOUtils?: Record<string, unknown>;
};

const BODY_HASH_PREF_KEY = "extensions.zotero.llmForZotero.skillBodyHashes";
const LOG_LEVEL_PREF = "extensions.zotero.llmforzotero.logLevel";

// The last shipped simple-paper-qa (v10), exactly as a profile would hold it.
const SHIPPED_SIMPLE_PAPER_QA_V10 = readFileSync(
  new URL("./fixtures/skillUpgrades/simple-paper-qa-v10.md", import.meta.url),
  "utf8",
);

function installProfile(
  baseDir: string,
  files: Record<string, string>,
  prefs: Map<string, string>,
): void {
  const dirs = new Set<string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  globalScope.Zotero = {
    DataDirectory: { dir: baseDir },
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, String(value)),
    },
    debug: () => undefined,
  };
  dirs.add(getCanonicalUserSkillsDir());
  globalScope.IOUtils = {
    exists: async (path: string) => dirs.has(path) || path in files,
    makeDirectory: async (path: string) => {
      dirs.add(path);
    },
    getChildren: async (path: string) => {
      const normalized = path.replace(/\/$/, "");
      const children = new Set<string>();
      for (const filePath of Object.keys(files)) {
        const parent = filePath.replace(/[\\/][^\\/]*$/, "");
        if (parent === normalized) children.add(filePath);
        else if (parent.replace(/[\\/][^\\/]*$/, "") === normalized)
          children.add(parent);
      }
      return [...children];
    },
    read: async (path: string) => encoder.encode(files[path] || ""),
    write: async (path: string, data: Uint8Array) => {
      files[path] = decoder.decode(data);
      return data.byteLength;
    },
    remove: async (path: string) => {
      delete files[path];
    },
  };
}

describe("retired shipped skills", function () {
  let originalZotero: typeof globalScope.Zotero;
  let originalIOUtils: typeof globalScope.IOUtils;

  beforeEach(function () {
    originalZotero = globalScope.Zotero;
    originalIOUtils = globalScope.IOUtils;
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
    globalScope.IOUtils = originalIOUtils;
    setAppLogSinkForTests(null);
  });

  it("no longer ships simple-paper-qa; evidence-based-qa covers broad single-paper summaries", function () {
    assert.notProperty(BUILTIN_SKILL_FILES, "simple-paper-qa.md");
    const evidence = parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"]);
    assert.include(
      evidence.description,
      "including broad summaries of one paper",
    );
    assert.deepEqual(evidence.supersedes, []);
    assert.include(evidence.contexts, "single-paper");
  });

  it("skips a stale customized profile copy on load, without throwing, and logs once", async function () {
    const files: Record<string, string> = {};
    const prefs = new Map<string, string>([[LOG_LEVEL_PREF, "debug"]]);
    installProfile("/tmp/llm-for-zotero-retired-load", files, prefs);
    files[getCanonicalSkillFilePath("simple-paper-qa")] =
      SHIPPED_SIMPLE_PAPER_QA_V10.replace(
        "## ",
        "My own paper-reading rule.\n\n## ",
      );
    files[getCanonicalSkillFilePath("evidence-based-qa")] =
      BUILTIN_SKILL_FILES["evidence-based-qa.md"];
    const logged: string[] = [];
    setAppLogSinkForTests((_level, args) => {
      logged.push(args.map(String).join(" "));
    });

    const first = await loadUserSkills();
    const second = await loadUserSkills();

    for (const skills of [first, second]) {
      assert.deepEqual(
        buildSkillInventory(skills).map((entry) => entry.id),
        ["evidence-based-qa"],
      );
    }
    const retiredLines = logged.filter((line) =>
      line.includes("simple-paper-qa"),
    );
    assert.lengthOf(retiredLines, 1);
    assert.include(
      retiredLines[0],
      "Skipped retired skill simple-paper-qa left in profile",
    );
  });

  for (const fixture of [
    "skillUpgrades/simple-paper-qa-v10.md",
    "skillUpgrades/simple-paper-qa-v9.md",
    "qaEvaluation/skills/simple-paper-qa-v8.md",
  ]) {
    it(`removes an unmodified shipped copy with no stored hash (${fixture})`, async function () {
      const files: Record<string, string> = {};
      const prefs = new Map<string, string>();
      installProfile("/tmp/llm-for-zotero-retired-bootstrap", files, prefs);
      const path = getCanonicalSkillFilePath("simple-paper-qa");
      files[path] = readFileSync(
        new URL(`./fixtures/${fixture}`, import.meta.url),
        "utf8",
      );
      await initUserSkills();
      assert.notProperty(files, path);
      const skills = await loadUserSkills();
      assert.notInclude(
        skills.map((skill) => skill.id),
        "simple-paper-qa",
      );
    });
  }

  it("removes a tracked untouched copy of an older shipped version", async function () {
    const raw = readFileSync(
      new URL(
        "./fixtures/skillUpgrades/simple-paper-qa-v9.md",
        import.meta.url,
      ),
      "utf8",
    );
    const files: Record<string, string> = {};
    const prefs = new Map<string, string>([
      [
        BODY_HASH_PREF_KEY,
        JSON.stringify({
          "simple-paper-qa.md": hashSkillForUpgrade(
            raw,
            parseSkill(raw).instruction,
          ),
        }),
      ],
    ]);
    installProfile("/tmp/llm-for-zotero-retired-tracked", files, prefs);
    const path = getCanonicalSkillFilePath("simple-paper-qa");
    files[path] = raw;
    await initUserSkills();
    assert.notProperty(files, path);
    assert.notProperty(
      JSON.parse(prefs.get(BODY_HASH_PREF_KEY) || "{}"),
      "simple-paper-qa.md",
    );
  });

  it("keeps a customized copy on disk", async function () {
    const files: Record<string, string> = {};
    installProfile(
      "/tmp/llm-for-zotero-retired-customized",
      files,
      new Map<string, string>(),
    );
    const path = getCanonicalSkillFilePath("simple-paper-qa");
    const customized = SHIPPED_SIMPLE_PAPER_QA_V10.replace(
      "## ",
      "My own paper-reading rule.\n\n## ",
    );
    files[path] = customized;
    await initUserSkills();
    assert.include(files[path], "My own paper-reading rule.");
  });
});
