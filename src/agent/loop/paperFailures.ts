/**
 * A failed tool call, as the host reads it for a long job: the papers it
 * named and why it failed. The runtime counts each paper's failures by their
 * reason, so the same failure twice on one paper (spec §6: "repeated errors
 * stop an item after the same failure twice") can be told from a new one.
 */

type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function itemTarget(value: unknown): string[] {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? [`item:${id}`] : [];
}

/**
 * The papers a call's arguments name, in the shapes the tools use: a paper
 * selector (`target`, `targets`), a write's `targetItemId`, and item ids.
 */
export function namedItemTargets(args: unknown): string[] {
  const input = record(args);
  if (!input) return [];
  const selectors = [
    record(input.target),
    ...(Array.isArray(input.targets) ? input.targets.map(record) : []),
  ];
  return [
    ...new Set([
      ...selectors.flatMap((selector) => itemTarget(selector?.itemId)),
      ...itemTarget(input.itemId),
      ...itemTarget(input.targetItemId),
      ...itemTarget(input.parentItemId),
      ...(Array.isArray(input.itemIds)
        ? input.itemIds.flatMap(itemTarget)
        : []),
    ]),
  ];
}

/** Long enough to tell failures apart, short enough for a Task progress row. */
const REASON_CHARACTERS = 200;

/** Why a call failed, in one line, the same way each time. */
export function toolFailureReason(content: unknown): string {
  const row = record(content);
  const error = row ? (record(row.error) ?? row.error) : undefined;
  const text =
    typeof content === "string"
      ? content
      : typeof error === "string"
        ? error
        : typeof record(error)?.message === "string"
          ? String(record(error)!.message)
          : typeof row?.message === "string"
            ? row.message
            : "";
  const line = text.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, REASON_CHARACTERS) : "The tool failed";
}
