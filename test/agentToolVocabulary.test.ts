import { assert } from "chai";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { sanitizeGeminiSchema } from "../src/agent/model/geminiNative";

/**
 * Pins the agent tool vocabulary: which tools the model sees, which stay
 * internal, and how many bytes the model-visible specs cost. Regenerate the
 * fixture deliberately with scripts/dump-agent-tool-vocabulary.mjs.
 */
type ToolVocabularyFixture = {
  visible: string[];
  internal: string[];
  specBytes: number;
};

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/agentToolVocabulary.json", import.meta.url),
    ),
    "utf8",
  ),
) as ToolVocabularyFixture;

/**
 * Guidance allowed past the cap, pinned at its current size so it cannot grow.
 * zotero_script's guidance is its sandbox API reference plus the undo-safety
 * rules (snapshot before mutating, shouldStop in long loops); it is not plan
 * workflow prose and has no other owner yet.
 */
const GUIDANCE_CAP_EXCEPTIONS: ReadonlyMap<string, number> = new Map([
  ["zotero_script", 5136],
]);

/**
 * The plan tools whose model-facing input schemas are capped. The cap measures
 * what the model receives: the compacted schema from `registry.listTools()`.
 */
const PLAN_SCHEMA_CAP = 6000;
const CAPPED_PLAN_TOOLS = ["research_update"] as const;

/**
 * Plan schemas allowed past the cap, pinned at their current size so they
 * cannot grow. research_update carries the per-paper finding shape the model
 * writes on every reading step; it embeds no other tool's schema.
 */
const PLAN_SCHEMA_CAP_EXCEPTIONS: ReadonlyMap<string, number> = new Map([
  ["research_update", 7168],
]);

/**
 * Model-facing paths Gemini receives as strings on purpose. research_update's
 * criterionResults and frameSlots are open JSON maps; an open map has no
 * fixed properties for Gemini to declare.
 */
const GEMINI_STRING_ALLOWLIST: ReadonlySet<string> = new Set([
  "research_update.papers[].criterionResults",
  "research_update.papers[].finding.frameSlots",
]);

const stub: any = new Proxy(function () {}, {
  get: () => stub,
  apply: () => stub,
});

describe("agent tool vocabulary", function () {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: stub,
    pdfService: stub,
    pdfPageService: stub,
    retrievalService: stub,
  });
  it("model-visible tool names match the committed fixture", function () {
    const names = registry
      .listTools()
      .map((t) => t.name)
      .sort();
    assert.deepEqual(names, fixture.visible);
  });
  it("internal tool names match the committed fixture", function () {
    const names = registry
      .listToolDefinitions()
      .filter((t) => t.spec.exposure === "internal")
      .map((t) => t.spec.name)
      .sort();
    assert.deepEqual(names, fixture.internal);
  });
  it("model-visible spec text does not grow past the fixture", function () {
    const bytes = registry
      .listTools()
      .reduce((n, t) => n + JSON.stringify(t).length, 0);
    assert.isAtMost(bytes, fixture.specBytes);
  });
  it("no tool description exceeds 1200 characters", function () {
    const over = registry
      .listToolDefinitions()
      .filter((t) => t.spec.description.length > 1200)
      .map((t) => `${t.spec.name}: ${t.spec.description.length}`);
    assert.deepEqual(over, []);
  });
  it("no tool guidance exceeds 2500 characters", function () {
    const over = registry
      .listToolDefinitions()
      .filter((t) => {
        const length = t.guidance?.instruction.length ?? 0;
        const pinned = GUIDANCE_CAP_EXCEPTIONS.get(t.spec.name);
        return pinned === undefined ? length > 2500 : length > pinned;
      })
      .map((t) => `${t.spec.name}: ${t.guidance!.instruction.length}`);
    assert.deepEqual(over, []);
  });
  it("every guidance cap exception is still needed", function () {
    for (const [name] of GUIDANCE_CAP_EXCEPTIONS) {
      const length = registry.getTool(name)?.guidance?.instruction.length ?? 0;
      assert.isAbove(length, 2500, `${name} fits the cap; drop its exception`);
    }
  });
  it("no plan tool schema exceeds 6000 characters", function () {
    const specs = new Map(registry.listTools().map((t) => [t.name, t]));
    const over = CAPPED_PLAN_TOOLS.flatMap((name) => {
      const spec = specs.get(name);
      assert.exists(spec, `${name} is model-visible`);
      const length = JSON.stringify(spec!.inputSchema).length;
      const pinned = PLAN_SCHEMA_CAP_EXCEPTIONS.get(name);
      return length > (pinned ?? PLAN_SCHEMA_CAP) ? [`${name}: ${length}`] : [];
    });
    assert.deepEqual(over, []);
  });
  it("every plan schema cap exception is still needed", function () {
    const specs = new Map(registry.listTools().map((t) => [t.name, t]));
    for (const [name] of PLAN_SCHEMA_CAP_EXCEPTIONS) {
      const length = JSON.stringify(specs.get(name)?.inputSchema ?? {}).length;
      assert.isAbove(
        length,
        PLAN_SCHEMA_CAP,
        `${name} fits the cap; drop its exception`,
      );
    }
  });
  it("no plan tool schema path degrades to a string under Gemini's sanitizer", function () {
    // sanitizeGeminiSchema turns a nested object with no properties into a
    // string parameter; a contract sent as a string never reaches the decoder
    // as a contract. Walk the model-facing schema beside its sanitized form.
    const specs = new Map(registry.listTools().map((t) => [t.name, t]));
    const degraded: string[] = [];
    const walk = (original: unknown, sanitized: unknown, path: string) => {
      if (!original || typeof original !== "object") return;
      if (!sanitized || typeof sanitized !== "object") return;
      const source = original as Record<string, unknown>;
      const result = sanitized as Record<string, unknown>;
      if (source.type !== "string" && result.type === "string") {
        degraded.push(path);
        return;
      }
      const properties = (source.properties || {}) as Record<string, unknown>;
      const sanitizedProperties = (result.properties || {}) as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(properties))
        walk(value, sanitizedProperties[key], `${path}.${key}`);
      if (source.items && result.items)
        walk(source.items, result.items, `${path}[]`);
    };
    for (const name of CAPPED_PLAN_TOOLS) {
      const schema = specs.get(name)?.inputSchema;
      walk(schema, sanitizeGeminiSchema(schema, { topLevel: true }), name);
    }
    assert.deepEqual(
      degraded.filter((path) => !GEMINI_STRING_ALLOWLIST.has(path)),
      [],
    );
  });
  it("a retired name is unknown to the registry and the error names the facade", async function () {
    const prepared = await registry.prepareExecution(
      { id: "c1", name: "apply_tags", arguments: {} } as any,
      {} as any,
    );
    const text = JSON.stringify(prepared);
    assert.match(text, /Unknown tool: apply_tags/);
    assert.include(text, "library_update kind:'tags'");
  });
  it("an unknown name that was never a tool gets no hint", async function () {
    const prepared = await registry.prepareExecution(
      { id: "c2", name: "no_such_tool", arguments: {} } as any,
      {} as any,
    );
    const text = JSON.stringify(prepared);
    assert.match(text, /Unknown tool: no_such_tool/);
    assert.notInclude(text, "renamed");
  });
});
