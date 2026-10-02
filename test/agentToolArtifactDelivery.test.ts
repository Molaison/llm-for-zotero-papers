import { assert } from "chai";
import {
  buildAdapterToolCallResult,
  filterFollowupMessageForCapabilities,
} from "../src/agent/model/toolArtifactDelivery";

describe("Agent tool artifact delivery", function () {
  it("keeps supported content and explains omitted content without changing the role", function () {
    const result = filterFollowupMessageForCapabilities(
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect the prepared inputs." },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          {
            type: "file_ref",
            file_ref: {
              name: "paper.pdf",
              mimeType: "application/pdf",
              storedPath: "/tmp/paper.pdf",
              contentHash: "hash",
            },
          },
        ],
      },
      {
        tools: true,
        contentInputs: {
          images: false,
          pdfDocuments: true,
          nativeFiles: false,
        },
      } as never,
      "Test model",
    );

    assert.equal(result?.role, "user");
    assert.isArray(result?.content);
    const parts = Array.isArray(result?.content) ? result.content : [];
    assert.deepEqual(
      parts.map((part) => part.type),
      ["text", "file_ref", "text"],
    );
    assert.match(
      parts[2]?.type === "text" ? parts[2].text : "",
      /1 image input.*Test model does not support image input/,
    );
  });

  it("converts one workflow outcome into the adapter tool-result contract", function () {
    const result = buildAdapterToolCallResult({
      toolResult: {
        callId: "call-1",
        name: "pdf_read",
        ok: true,
        content: { ignored: true },
      },
      delivery: {
        callId: "call-1",
        name: "pdf_read",
        content: { page: 3 },
        followupMessages: [
          { role: "user", content: "Use this page." },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AA" },
              },
            ],
          },
        ],
      },
    });

    assert.isTrue(result.success);
    assert.deepEqual(result.contentItems, [
      { type: "inputText", text: '{"page":3}' },
      { type: "inputText", text: "Use this page." },
      { type: "inputImage", imageUrl: "data:image/png;base64,AA" },
    ]);
  });

  it("compacts structured results without changing evidence, receipts, or whitespace inside text", function () {
    const content = {
      text: "Paragraph one.\n\n  Indented code: a = 1\n\treturn a;",
      papers: [
        { quoteId: "Q1", offsets: [0, 42], source: { itemId: 17, page: 3 } },
      ],
      actionReceipts: [{ id: "receipt-1", verified: true, noteId: 500 }],
      missing: null,
    };
    for (const delivery of [
      undefined,
      { callId: "call-1", name: "paper_read", content, followupMessages: [] },
    ]) {
      const result = buildAdapterToolCallResult({
        toolResult: { callId: "call-1", name: "paper_read", ok: true, content },
        ...(delivery ? { delivery } : {}),
      });
      const text = result.contentItems[0];
      assert.equal(text.type, "inputText");
      if (text.type !== "inputText") continue;
      assert.deepEqual(JSON.parse(text.text), content);
      assert.notInclude(text.text, "\n");
      assert.isBelow(text.text.length, JSON.stringify(content, null, 2).length);
    }
  });

  it("preserves already textual tool results verbatim", function () {
    const content =
      '{\n  "example": "keep this formatting"\n}\n\n```python\n  print(1)\n```';
    const result = buildAdapterToolCallResult({
      toolResult: {
        callId: "call-1",
        name: "context_read",
        ok: true,
        content,
      },
    });
    assert.deepEqual(result.contentItems, [
      { type: "inputText", text: content },
    ]);
  });
});
