import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { assert } from "chai";
import { resolveContextSourceItem } from "../src/modules/contextPanel/contextResolution";
import { collectAssistantCitationCandidates } from "../src/modules/contextPanel/assistantCitationLinks";
import { nativeReplayBanner } from "./helpers/nativeReplayBanner";

describe("local replay completion metadata boundary", () => {
  it("resolves the complete production no-reader/no-paper candidate path without host items or blocked APIs", () => {
    const context: any = {_globalThis: {}, Zotero: new Proxy({}, {get: (_host, key) => {
      throw new Error(`Unexpected host metadata access ${String(key)}`);
    }})};
    runInNewContext(nativeReplayBanner, context);
    const nativeSource = readFileSync("test/stableReading.native.ts", "utf8");
    const start = nativeSource.indexOf("export function createStableReadingReplayItem");
    const end = nativeSource.indexOf("\n}",start)+2;
    const compiled = ts.transpileModule(nativeSource.slice(start,end), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
    const exports: any = {};
    runInNewContext(compiled,{exports});
    const item = exports.createStableReadingReplayItem();
    const globals = globalThis as any;
    const original = {Zotero: globals.Zotero, ZoteroPane: globals.ZoteroPane};
    globals.Zotero = context.__nativeReplayZotero;
    globals.ZoteroPane = context.__replayPane; // Same scoped esbuild alias as both native bundles.
    try {
      const source = resolveContextSourceItem(item);
      assert.isNull(source.contextItem);
      assert.equal(source.sourceKind,"none");
      assert.strictEqual(source.ownerItem,item);
      const candidates = collectAssistantCitationCandidates(item,{role:"user",text:"Local math replay",timestamp:1});
      assert.lengthOf(candidates,0);
      assert.lengthOf(context.__replayAudit.blocked,0);
      assert.isAtLeast(context.__replayAudit.virtualItemLookups,2);
      assert.isAtLeast(context.__replayAudit.virtualReaderLookups,2);
      assert.isAtLeast(context.__replayAudit.virtualPaneLookups,2);
      assert.lengthOf(item.getAttachments(),0);
    } finally {
      globals.Zotero = original.Zotero;
      if (original.ZoteroPane === undefined) delete globals.ZoteroPane;
      else globals.ZoteroPane = original.ZoteroPane;
    }
  });
});
