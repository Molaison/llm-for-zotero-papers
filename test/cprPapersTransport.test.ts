import { assert } from "chai";
import { gunzipSync, strFromU8, strToU8 } from "fflate";
import { describe, it } from "mocha";
import {
  CPR_PAPERS_GZIP_THRESHOLD_BYTES,
  describeCprPapersHttpFailure,
  encodeCprPapersRequestBody,
} from "../src/utils/cprPapers";

function firstTurnPayload(fileData: string) {
  return {
    model: "papers/gpt-6-sol",
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "before" },
          { type: "input_file", filename: "paper.pdf", file_data: fileData },
          { type: "input_text", text: "after" },
        ],
      },
    ],
  };
}

describe("CPR papers request transport", function () {
  it("gzip-compresses a large first-turn PDF body without changing its JSON", function () {
    const payload = firstTurnPayload(
      `data:application/pdf;base64,${"A".repeat(
        CPR_PAPERS_GZIP_THRESHOLD_BYTES,
      )}`,
    );
    const json = JSON.stringify(payload);
    const encoded = encodeCprPapersRequestBody(payload);

    assert.equal(encoded.contentEncoding, "gzip");
    assert.equal(encoded.jsonBytes, strToU8(json).byteLength);
    assert.instanceOf(encoded.body, ArrayBuffer);
    const wire = new Uint8Array(encoded.body as ArrayBuffer);
    assert.equal(encoded.wireBytes, wire.byteLength);
    const decodedJson = strFromU8(gunzipSync(wire));
    assert.equal(decodedJson, json);
    assert.deepEqual(strToU8(decodedJson), strToU8(json));

    const decoded = JSON.parse(decodedJson) as {
      input: Array<{ content: Array<{ type: string }> }>;
    };
    assert.deepEqual(
      decoded.input[0].content.map((part) => part.type),
      ["input_text", "input_file", "input_text"],
    );
  });

  it("keeps a small first-turn PDF body as plain JSON", function () {
    const payload = firstTurnPayload("data:application/pdf;base64,AAAA");
    const json = JSON.stringify(payload);
    const encoded = encodeCprPapersRequestBody(payload);

    assert.equal(encoded.contentEncoding, "identity");
    assert.isString(encoded.body);
    assert.equal(encoded.body, json);
    assert.equal(encoded.wireBytes, strToU8(json).byteLength);
  });

  it("keeps a large non-PDF / ready follow-up body as plain JSON", function () {
    const payload = {
      model: "papers/gpt-6-sol",
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "x".repeat(CPR_PAPERS_GZIP_THRESHOLD_BYTES),
            },
          ],
        },
      ],
    };
    const encoded = encodeCprPapersRequestBody(payload);

    assert.equal(encoded.contentEncoding, "identity");
    assert.isString(encoded.body);
    assert.isAbove(encoded.jsonBytes, CPR_PAPERS_GZIP_THRESHOLD_BYTES);
  });

  it("keeps a CF HTML 520 error short and preserves cf-ray", function () {
    const failure = describeCprPapersHttpFailure({
      status: 520,
      bodyText:
        "<!DOCTYPE html><html><body><h1>Cloudflare error</h1><p>origin returned an invalid response</p></body></html>",
      cfRay: "8f3a2b1c9d7e6f5a-HKG",
      requestId: "req-html-520",
      wireBytes: 123456,
      contentEncoding: "gzip",
    });

    assert.include(failure.error, "HTTP 520");
    assert.include(failure.error, "wire=123456 bytes");
    assert.include(failure.error, "encoding=gzip");
    assert.include(failure.error, "cf-ray=8f3a2b1c9d7e6f5a-HKG");
    assert.notInclude(failure.error, "<");
    assert.notInclude(failure.error, "Cloudflare error");
    assert.isUndefined(failure.responseMessage);
  });

  it("keeps a short safe JSON error message without dumping the body", function () {
    const failure = describeCprPapersHttpFailure({
      status: 400,
      bodyText: '{"error":{"message":"request body too large <b>now</b>"}}',
      requestId: "req-json-400",
      wireBytes: 98765,
      contentEncoding: "identity",
    });

    assert.include(failure.error, "HTTP 400");
    assert.include(failure.error, "wire=98765 bytes");
    assert.include(failure.error, "encoding=identity");
    assert.include(failure.error, "x-request-id=req-json-400");
    assert.include(failure.error, "message=request body too large now");
    assert.notInclude(failure.error, "<b>");
    assert.equal(failure.responseMessage, "request body too large now");
  });
});
