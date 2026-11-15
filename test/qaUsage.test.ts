import { assert } from "chai";
import { usageFromResponse } from "./helpers/qaUsage";
describe("QA evaluation provider accounting", function () {
  it("counts terminal usage once instead of summing streaming snapshots", function () {
    const text = [
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":2}}}',
      "data: [DONE]",
    ].join("\n");
    assert.deepEqual(usageFromResponse(text), {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 4,
      reasoningTokens: 2,
    });
  });
  it("keeps absent provider usage unknown", function () {
    assert.isNull(usageFromResponse('{"choices":[]}'));
  });
  it("captures nonstream utility calls", function () {
    assert.equal(
      usageFromResponse('{"usage":{"prompt_tokens":9,"completion_tokens":3}}')
        ?.totalTokens,
      12,
    );
  });

  it("includes cached Anthropic input and merges message-start with output deltas", function () {
    const text =
      'data: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}\ndata: {"usage":{"output_tokens":5}}';
    assert.equal(usageFromResponse(text)?.inputTokens, 130);
    assert.equal(usageFromResponse(text)?.totalTokens, 135);
  });
});
