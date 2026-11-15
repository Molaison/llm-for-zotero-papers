import fs from "node:fs";
import path from "node:path";
import { assert } from "chai";

describe("webchat extension DOM contracts", function () {
  const syncRepo = path.resolve(process.cwd(), "../sync-for-zotero");
  const contentScript = path.join(syncRepo, "extension/content_script.js");

  it("keeps DeepSeek extraction compatible with Chrome 102 selector support", function () {
    if (!fs.existsSync(contentScript)) {
      this.skip();
    }

    const source = fs.readFileSync(contentScript, "utf8");

    assert.notInclude(source, "div.ds-message:not(:has");
    assert.notInclude(source, "div.ds-message:has(.ds-markdown)");
    assert.include(source, 'conversationMessageSelector: "div.ds-message"');
    assert.include(source, 'userMessageSelector: "div.ds-message"');
    assert.include(source, "assistantMessageSelectors");
    assert.include(source, '".ds-think-content"');
    assert.include(source, "\"[class*='think']\"");
    assert.include(source, "getUserMessageCount()");
  });
});
