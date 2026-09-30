import { assert } from "chai";
import { readFileSync } from "node:fs";
import { AGENT_PERSONA_INSTRUCTIONS } from "../src/agent/model/agentPersona";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { createBuiltInToolRegistry } from "../src/agent/tools";

/**
 * Every behavioral prompt rule has one owner. An owner is one tool (its
 * description, model-facing description, and guidance together), the
 * persona (all its sections), one shipped skill file, or the message
 * builder's hard-coded prompt sections. A marker phrase distinctive for a
 * rule must appear in exactly the expected owner.
 */
function stubDependency(): never {
  const stub: unknown = new Proxy(function () {}, {
    get: (_target, property) =>
      property === "then" ? undefined : stubDependency(),
    apply: () => undefined,
  });
  return stub as never;
}

function collectOwnerTexts(): Map<string, string> {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: stubDependency(),
    pdfService: stubDependency(),
    pdfPageService: stubDependency(),
    retrievalService: stubDependency(),
  });
  const modelDescriptions = new Map(
    registry.listTools().map((spec) => [spec.name, spec.description]),
  );
  const owners = new Map<string, string>();
  owners.set("persona", AGENT_PERSONA_INSTRUCTIONS.join("\n"));
  for (const tool of registry.listToolDefinitions()) {
    owners.set(
      `tool:${tool.spec.name}`,
      [
        tool.spec.description,
        modelDescriptions.get(tool.spec.name) || "",
        tool.guidance?.instruction || "",
      ].join("\n"),
    );
  }
  for (const [filename, content] of Object.entries(BUILTIN_SKILL_FILES)) {
    owners.set(`skill:${filename}`, content);
  }
  owners.set(
    "messageBuilder",
    readFileSync(
      new URL("../src/agent/model/messageBuilder.ts", import.meta.url),
      "utf8",
    ),
  );
  return owners;
}

function ownersOf(owners: Map<string, string>, marker: string): string[] {
  return Array.from(owners.entries())
    .filter(([, text]) => text.includes(marker))
    .map(([owner]) => owner)
    .sort();
}

describe("prompt rules have a single owner", function () {
  const rules: Array<{ rule: string; marker: string; owner: string }> = [
    {
      rule: "paper_read mode selection",
      marker: "mode:'overview'",
      owner: "tool:paper_read",
    },
    {
      rule: "paper_read evidence-progress handling",
      marker: "paperEvidenceProgress",
      owner: "tool:paper_read",
    },
    {
      rule: "paper_read single-fact topK default",
      marker: "topK:3",
      owner: "tool:paper_read",
    },
    {
      rule: "collection scope never reads the active paper implicitly",
      marker: "implicit target",
      owner: "tool:paper_read",
    },
    {
      rule: "library_retrieve body-evidence floor",
      marker: "papersBodyRead",
      owner: "tool:library_retrieve",
    },
    {
      rule: "literature discovery never imports",
      marker: "discovery never imports",
      owner: "tool:literature_search",
    },
    {
      rule: "figure crops come only from paper_read figures mode",
      marker: "figure_crops",
      owner: "skill:analyze-figures.md",
    },
    {
      rule: "failed figure extraction falls back to text",
      marker: "MinerU source images, or placeholders",
      owner: "skill:analyze-figures.md",
    },
  ];

  const owners = collectOwnerTexts();

  it("collects the persona, every tool, every shipped skill, and the message builder", function () {
    assert.isAtLeast(
      Array.from(owners.keys()).filter((key) => key.startsWith("tool:")).length,
      30,
    );
    assert.isAtLeast(
      Array.from(owners.keys()).filter((key) => key.startsWith("skill:"))
        .length,
      7,
    );
    assert.isTrue(owners.has("persona"));
    assert.isTrue(owners.has("messageBuilder"));
  });

  for (const { rule, marker, owner } of rules) {
    it(`${rule} lives only in ${owner}`, function () {
      assert.deepEqual(ownersOf(owners, marker), [owner], marker);
    });
  }
});
