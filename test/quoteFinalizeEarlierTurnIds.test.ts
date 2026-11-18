import { assert } from "chai";
import { getMessageQuoteDisplay } from "../src/modules/contextPanel/quoteRenderPlan";
import { finalizeAssistantMessageQuoteCitationsForTests } from "../src/modules/contextPanel/quoteValidation/scheduling";
import { chatHistory } from "../src/modules/contextPanel/state";
import {
  buildQuoteCitation,
  finalizeAssistantQuoteCitations,
} from "../src/services/quotes/quoteCitations";
import type { Message } from "../src/modules/contextPanel/types";

const KEY = 987001;

function citation(id: string) {
  return buildQuoteCitation({
    id,
    quoteText:
      "Place cells in CA1 remapped across days when the animals explored a novel environment.",
    citationLabel: "(Example et al., 2024)",
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
    contextItemId: 12,
    itemId: 11,
  })!;
}

function message(role: "user" | "assistant", text: string, ts: number) {
  return { role, text, timestamp: ts } as Message;
}

/** The citation ids the reader would still see after the paragraph gate. */
function keptIds(m: Message): string[] {
  const display = getMessageQuoteDisplay(m);
  const finalized = finalizeAssistantQuoteCitations({
    markdown: display.markdown,
    quoteCitations: display.quoteCitations,
  });
  return finalized.quoteCitations.map((c) => c.id);
}

describe("finalize keeps citation ids delivered in earlier turns", function () {
  let earlier: Message;
  let current: Message;

  beforeEach(function () {
    earlier = message("assistant", "Turn one. [[cite:Q_early1]]", 1);
    earlier.quoteCitations = [citation("Q_early1"), citation("Q_early2")];
    current = message("assistant", "Turn two. [[cite:Q_early1]]", 3);
    chatHistory.set(KEY, [
      message("user", "q1", 0),
      earlier,
      message("user", "q2", 2),
      current,
    ]);
  });

  afterEach(function () {
    chatHistory.delete(KEY);
  });

  it("retains an earlier-turn id the new answer references", function () {
    finalizeAssistantMessageQuoteCitationsForTests(current, {
      conversationKey: KEY,
    });
    assert.deepEqual(
      current.quoteCitations?.map((c) => c.id),
      ["Q_early1"],
    );
    assert.deepEqual(keptIds(current), ["Q_early1"]);
  });

  it("still drops an id that no earlier turn delivered", function () {
    current.text = "Turn two. [[cite:Q_unknown9]]";
    finalizeAssistantMessageQuoteCitationsForTests(current, {
      conversationKey: KEY,
    });
    assert.isUndefined(current.quoteCitations);
    assert.deepEqual(keptIds(current), []);
  });

  it("does not add earlier citations the answer does not reference", function () {
    finalizeAssistantMessageQuoteCitationsForTests(current, {
      conversationKey: KEY,
    });
    assert.notInclude(
      (current.quoteCitations || []).map((c) => c.id),
      "Q_early2",
    );
  });

  it("does nothing without a conversation key", function () {
    finalizeAssistantMessageQuoteCitationsForTests(current);
    assert.isUndefined(current.quoteCitations);
    assert.deepEqual(keptIds(current), []);
  });

  it("does not recover an id that only a later turn holds", function () {
    const later = message("assistant", "Turn three.", 5);
    later.quoteCitations = [citation("Q_late")];
    earlier.text = "Turn one. [[cite:Q_late]]";
    earlier.quoteCitations = undefined;
    chatHistory.set(KEY, [
      message("user", "q1", 0),
      earlier,
      message("user", "q2", 2),
      current,
      message("user", "q3", 4),
      later,
    ]);
    finalizeAssistantMessageQuoteCitationsForTests(earlier, {
      conversationKey: KEY,
    });
    assert.isUndefined(earlier.quoteCitations);
  });

  it("recovers an earlier turn's id when finalizing a later turn", function () {
    const later = message("assistant", "Turn three. [[cite:Q_early2]]", 5);
    chatHistory.set(KEY, [
      message("user", "q1", 0),
      earlier,
      message("user", "q2", 2),
      current,
      message("user", "q3", 4),
      later,
    ]);
    finalizeAssistantMessageQuoteCitationsForTests(later, {
      conversationKey: KEY,
    });
    assert.deepEqual(
      later.quoteCitations?.map((c) => c.id),
      ["Q_early2"],
    );
  });
});
