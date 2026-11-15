import { assert } from "chai";

import { redactToolArgumentPreview } from "../src/agent/toolArgumentDiagnostics";

describe("tool argument diagnostics", function () {
  it("redacts unquoted multi-word content-like malformed arguments", function () {
    const preview = redactToolArgumentPreview(
      "{ action: write, content: secret generated script body with token abc123 }",
    );

    assert.include(preview, "[redacted]");
    assert.notInclude(preview, "secret generated script body");
    assert.notInclude(preview, "token");
    assert.notInclude(preview, "abc123");
  });

  it("preserves sibling fields after redacting unquoted content-like values", function () {
    const preview = redactToolArgumentPreview(
      "{ action: write, content: secret generated script body, filePath: /tmp/out.py }",
    );

    assert.include(preview, 'content: "[redacted]"');
    assert.include(preview, "filePath: /tmp/out.py");
    assert.notInclude(preview, "secret generated script body");
  });

  it("does not redact content-like words inside longer field names", function () {
    const preview = redactToolArgumentPreview(
      '{"metadata":"public","userdata":"safe","subtext":"visible","mybody":"shown"}',
    );

    assert.include(preview, '"metadata":"public"');
    assert.include(preview, '"userdata":"safe"');
    assert.include(preview, '"subtext":"visible"');
    assert.include(preview, '"mybody":"shown"');
    assert.notInclude(preview, "[redacted]");
  });

  it("redacts exact quoted and unquoted content-like keys", function () {
    const preview = redactToolArgumentPreview(
      "{ content: secret notes, 'data': 'secret payload', script: console.log(secret) }",
    );

    assert.include(preview, 'content: "[redacted]"');
    assert.include(preview, "'data': \"[redacted]\"");
    assert.include(preview, 'script: "[redacted]"');
    assert.notInclude(preview, "secret notes");
    assert.notInclude(preview, "secret payload");
    assert.notInclude(preview, "console.log");
  });

  it("redacts unquoted content through unsafe closing delimiters", function () {
    const preview = redactToolArgumentPreview(
      '{"content": # notes {"k":1} REST WITH SECRET]',
    );

    assert.include(preview, '"content": "[redacted]"');
    assert.notInclude(preview, "REST WITH SECRET");
    assert.notInclude(preview, '"k"');
  });

  it("continues redacting quoted content-like malformed arguments", function () {
    const preview = redactToolArgumentPreview(
      '{"action":"write","content":"secret generated script body"',
    );

    assert.include(preview, '"content":"[redacted]"');
    assert.notInclude(preview, "secret generated script body");
  });
});
