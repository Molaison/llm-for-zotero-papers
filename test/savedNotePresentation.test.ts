import { assert } from "chai";
import { savedNoteIsPrimaryOutcome } from "../src/modules/contextPanel/agentTrace/savedNoteCard";
import type { AgentEvent } from "../src/agent/types";

describe("saved note primary outcome", function () {
  it("uses the frozen deliverable to preserve separate documents and plans", function () {
    // The contract a classifier-era run stored with its trace.
    const contract = {
      version: 4,
      id: "contract:note_create",
      writeDisposition: "required",
      interpretationSource: "semantic",
      intent: {
        retrievalIntent: "none",
        deliverableIntent: "chat",
        wantedSections: [],
        actionIntents: [],
        semantic: { version: 1, id: "semantic:test", revision: 1 },
      },
      obligations: [],
    };
    const events = [
      {
        type: "provider_event",
        providerType: "agent_action_contract",
        payload: { contract },
      },
    ] as AgentEvent[];
    assert.isTrue(savedNoteIsPrimaryOutcome(events, false));
    assert.isFalse(savedNoteIsPrimaryOutcome(events, true));
    contract.intent.deliverableIntent = "document";
    assert.isFalse(savedNoteIsPrimaryOutcome(events, false));
    assert.isFalse(savedNoteIsPrimaryOutcome([], false));
  });
});
