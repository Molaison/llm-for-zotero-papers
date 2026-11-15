// scripts/dump-agent-tool-vocabulary.mjs
// Usage: npx tsx --require ./test/register.cjs scripts/dump-agent-tool-vocabulary.mjs > test/fixtures/agentToolVocabulary.json
// Loaded through require (not a static import) so the CommonJS hooks in
// test/register.cjs -- notably the ".md" loader for skill files -- apply.
import { createRequire } from "module";
const { createBuiltInToolRegistry } = createRequire(import.meta.url)(
  "../src/agent/tools/index.ts",
);
const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
const registry = createBuiltInToolRegistry({
  zoteroGateway: stub,
  pdfService: stub,
  pdfPageService: stub,
  retrievalService: stub,
});
const all = registry.listToolDefinitions();
const visible = registry.listTools();
const out = {
  visible: visible.map((t) => t.name).sort(),
  internal: all
    .filter((t) => t.spec.exposure === "internal")
    .map((t) => t.spec.name)
    .sort(),
  specBytes: visible.reduce((n, t) => n + JSON.stringify(t).length, 0),
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
