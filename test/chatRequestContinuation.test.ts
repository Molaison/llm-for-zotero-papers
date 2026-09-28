import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { readFileSync } from "node:fs";

import {
  clearAllState,
  isRequestActive,
  setCancelledRequestId,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";

/**
 * Issue #481: switching to another conversation while a request is still
 * preparing must not cancel it. Only the request's own cancel token — it
 * still owns its conversation, the user has not cancelled it, and its abort
 * signal has not fired — decides whether preparation continues. Which
 * conversation a panel currently shows only decides where content renders.
 *
 * `sendQuestion` and `retryLatestAssistantResponse` need a live panel, a
 * Zotero item and a provider, so their continuation predicates are pinned at
 * the source level; the shared predicate is exercised behaviourally.
 */

const CHAT_SOURCE_PATH = "src/modules/contextPanel/chat.ts";

function readChatSource(): string {
  return readFileSync(CHAT_SOURCE_PATH, "utf8");
}

function sliceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  assert.isAtLeast(start, 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.isAtLeast(end, 0, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

const PANEL_OWNERSHIP_CHECKS = [
  "requireCurrentPanelOwnership",
  "isPanelOperationLeaseCurrent",
  "isOwnershipCurrent",
];

function assertNoPanelOwnershipCheck(slice: string, label: string) {
  for (const check of PANEL_OWNERSHIP_CHECKS) {
    assert.notInclude(
      slice,
      check,
      `${label} must not stop the request when the panel switches away`,
    );
  }
}

describe("chat request continuation (#481)", function () {
  afterEach(() => {
    clearAllState();
  });

  describe("isRequestActive", function () {
    it("is true for the owning, uncancelled, unaborted request", function () {
      const controller = new AbortController();
      assert.isTrue(tryBeginRequest(301, 4, controller));
      assert.isTrue(isRequestActive(301, 4));
    });

    it("is false for a request that does not own the conversation", function () {
      assert.isTrue(tryBeginRequest(302, 4, new AbortController()));
      assert.isFalse(isRequestActive(302, 3));
      assert.isFalse(isRequestActive(302, 5));
      assert.isFalse(isRequestActive(303, 4));
    });

    it("is false once the user cancelled the request", function () {
      assert.isTrue(tryBeginRequest(304, 4, new AbortController()));
      setCancelledRequestId(304, 4);
      assert.isFalse(isRequestActive(304, 4));
    });

    it("is false once the request's abort signal fired", function () {
      const controller = new AbortController();
      assert.isTrue(tryBeginRequest(305, 4, controller));
      controller.abort();
      assert.isFalse(isRequestActive(305, 4));
    });

    it("is true for an owner with no abort controller", function () {
      assert.isTrue(tryBeginRequest(306, 4, null));
      assert.isTrue(isRequestActive(306, 4));
    });
  });

  describe("source pins", function () {
    it("sendQuestion continues regardless of which conversation the panel shows", function () {
      const source = readChatSource();
      const sendFlow = sliceBetween(
        source,
        "export async function sendQuestion(",
        "function buildInlineEditWidget(",
      );
      const predicate = sliceBetween(
        sendFlow,
        "const requestIsActive = (conversationKey: number) =>",
        "const finishBeforeDispatch",
      );
      assertNoPanelOwnershipCheck(predicate, "sendQuestion.requestIsActive");
      assert.include(predicate, "isRequestActive(");
    });

    it("retryLatestAssistantResponse continues regardless of which conversation the panel shows", function () {
      const source = readChatSource();
      const retryFlow = sliceBetween(
        source,
        "export async function retryLatestAssistantResponse(",
        "async function detachProviderForEdit(",
      );
      const predicate = sliceBetween(
        retryFlow,
        "const requestIsActive = () =>",
        "const releaseRequest",
      );
      assertNoPanelOwnershipCheck(
        predicate,
        "retryLatestAssistantResponse.requestIsActive",
      );
      assert.include(predicate, "isRequestActive(");
    });

    it("notifyProviderDispatch always reports the dispatch", function () {
      const source = readChatSource();
      const notify = sliceBetween(
        source,
        "function notifyProviderDispatch(",
        "\n}\n",
      );
      assert.notMatch(notify, /return false/);
      assert.include(notify, "callback?.()");
    });

    it("the agent dispatch path is not fenced by panel ownership", function () {
      const source = readChatSource();
      assert.notInclude(source, "createOwnershipFencedProviderDispatch");
      assert.notInclude(source, "Panel ownership changed before dispatch");

      const sendAgent = sliceBetween(
        source,
        "async function sendAgentQuestion(",
        "export async function sendQuestion(",
      );
      // Only the entry gate (before a request exists) may check ownership.
      assert.lengthOf(
        sendAgent.match(/isOwnershipCurrent\("/g) || [],
        1,
        "sendAgentQuestion keeps only its entry ownership check",
      );
      assert.include(sendAgent, 'isOwnershipCurrent("send-agent-question")');

      const retryAgent = sliceBetween(
        source,
        "async function retryLatestAgentResponse(",
        "async function sendAgentQuestion(",
      );
      assert.lengthOf(
        retryAgent.match(/isOwnershipCurrent\("/g) || [],
        1,
        "retryLatestAgentResponse keeps only its entry ownership check",
      );
      assert.include(retryAgent, 'isOwnershipCurrent("retry-agent-response")');
    });
  });
});
