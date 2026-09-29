import { assert } from "chai";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createBuiltInToolRegistry } from "../src/agent/tools";

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
});
