const CONTINUE_COMMANDS = new Set([
  "continue",
  "resume",
  "go on",
  "keep going",
  "proceed",
  "continue the plan",
  "resume the plan",
  "继续",
  "继续执行",
  "繼續",
  "繼續執行",
]);

/**
 * Whether a whole message asks for stored work to continue: an interrupted
 * run's outcome ledger.
 *
 * Case, surrounding space and trailing punctuation are ignored; nothing else
 * is: "continue with a different question" is a new request, and resuming
 * with it would swallow the question.
 */
export function isExplicitContinueCommand(text: string): boolean {
  const command = text
    .trim()
    .replace(/[\s\p{P}]+$/u, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return CONTINUE_COMMANDS.has(command);
}
