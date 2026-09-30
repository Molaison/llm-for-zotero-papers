/**
 * Why an Original Agent run ended.
 *
 * Every ending of `AgentRuntime.runTurn` names exactly one rule. The rule is
 * recorded as an `agent_run_stop` provider event just before the run is
 * finished, and it is diagnostic only: nothing decides behavior from it.
 */
export type RunStopRule =
  // A model without tool support was asked for a required document.
  | "tools_unsupported_document"
  // A model without tool support hands the turn back for a direct response.
  | "tools_unsupported_fallback"
  // A /compact request ended the turn without a model step.
  | "manual_compaction"
  // The plan session could not bind the plan this turn plans or executes.
  | "plan_initialization_failed"
  // The action contract could not be set up or restored for this turn.
  | "action_contract_initialization_failed"
  // A prepared action asked the user for input and got no usable answer.
  | "awaiting_clarification"
  // The user answered, but the prepared action's references stay unresolved.
  | "references_unresolved"
  // The host workflow's next step is blocked.
  | "host_workflow_blocked"
  // The host workflow finished, but the action contract rejected the result.
  | "host_workflow_rejected"
  // The host workflow finished and reported its verified actions.
  | "host_workflow_complete"
  // A host-prepared action failed or could not be verified.
  | "host_action_failed"
  // The protected prompt stays above the input budget after compaction.
  | "prompt_budget_exceeded"
  // A tool the provider ran through its callback ended the run.
  | "provider_terminal_outcome"
  // A final answer kept hitting the output limit; the kept text ships.
  | "answer_continuation_limit"
  // The response stream broke again after its one automatic retry.
  | "stream_interrupted_again"
  // Incomplete model steps reached the segment's round limit.
  | "incomplete_step_limit"
  // The final-answer gate rejected the answer and allows no more corrections.
  | "final_gate_rejected"
  // The model's final answer passed the final-answer gate.
  | "final_answer"
  // A step asked for too many tool calls after its one retry, or at the limit.
  | "tool_call_overflow"
  // A tool the model called ended the run with its terminal result.
  | "terminal_tool"
  // A tool the model called could not run or verify its action.
  | "tool_action_failed"
  // Three rounds in a row had failing tools and no successful result.
  | "repeated_tool_errors"
  // Six rounds in a row had only rejected tool inputs.
  | "repeated_input_rejections"
  // A whole segment of rounds produced no new successful tool result.
  | "segment_without_progress"
  // The user stopped the run before its next model step was sent.
  | "cancelled_before_step"
  // The user stopped the run while a model step or tool was in flight.
  | "cancelled_in_flight"
  // A provider or runtime error escaped the loop; the run is left to recover.
  | "interrupted_by_error";
