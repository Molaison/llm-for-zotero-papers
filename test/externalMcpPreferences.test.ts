import { assert } from "chai";
import { readFileSync } from "node:fs";

describe("external MCP permission ownership", function () {
  it("does not expose duplicate Zotero permission controls", function () {
    const markup = readFileSync("addon/content/preferences.xhtml", "utf8");
    assert.notInclude(markup, 'id="__addonRef__-external-mcp-settings"');
    const defaults = readFileSync("addon/prefs.js", "utf8");
    for (const key of [
      "externalMcpWritesEnabled",
      "externalMcpFilesEnabled",
      "externalMcpCommandsEnabled",
      "externalMcpReadDirectories",
      "externalMcpWriteDirectories",
    ])
      assert.notInclude(defaults, key);
  });
});
