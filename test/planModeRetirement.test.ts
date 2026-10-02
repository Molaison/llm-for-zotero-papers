/**
 * Plan mode is retired: no path puts a turn into a plan. A retry needs a live
 * panel, a Zotero item and a provider, so, as `chatRequestContinuation.test.ts`
 * explains, its guard is pinned at the source level.
 */
import { assert } from "chai";
import { readFileSync } from "node:fs";

function sliceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  assert.isAtLeast(start, 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.isAtLeast(end, 0, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

describe("plan mode retirement", function () {
  it("never retries a turn with the plan context an old Codex run recorded", function () {
    const retryFlow = sliceBetween(
      readFileSync("src/modules/contextPanel/chat.ts", "utf8"),
      "export async function retryLatestAssistantResponse(",
      "async function detachProviderForEdit(",
    );
    assert.notInclude(retryFlow, "codex_plan_context");
    assert.notMatch(retryFlow, /\bplanContext\b/);
  });
});
