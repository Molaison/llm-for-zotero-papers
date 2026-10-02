/**
 * The form an evidence ref takes in a tool result the model reads.
 *
 * A read observation's id is its call digest and its row,
 * `sha256:<64 hex>:<row>`, and every ref of one result repeats the same
 * digest. The model is shown `<first 12 hex>:<row>` instead: still a token
 * it can copy into a citation, at a fifth of the length. The host expands a
 * short ref to the one observation of the conversation it names before any
 * check reads it, so stored documents keep full ids, and a full id (from an
 * older conversation or a stored document) is accepted as it is.
 */
export const SHORT_EVIDENCE_REF_DIGITS = 12;

const OBSERVATION_ID = /^sha256:([0-9a-f]{64}):(\d+)$/;
const SHORT_REF = new RegExp(
  `^([0-9a-f]{${SHORT_EVIDENCE_REF_DIGITS}}):(\\d+)$`,
);

/** The short ref a tool result shows for a read observation id. */
export function shortEvidenceRef(observationId: string): string {
  const match = OBSERVATION_ID.exec(observationId);
  return match
    ? `${match[1].slice(0, SHORT_EVIDENCE_REF_DIGITS)}:${match[2]}`
    : observationId;
}

/**
 * Each ref as the full observation id it names among `observationIds`. A
 * full id, an unknown ref, and a short ref two observations share stay as
 * they are, for the evidence checks to refuse.
 */
export function expandEvidenceRefs(
  refs: readonly string[],
  observationIds: readonly string[],
): string[] {
  let byShortRef: Map<string, string | null> | undefined;
  return refs.map((ref) => {
    if (!SHORT_REF.test(ref)) return ref;
    if (!byShortRef) {
      byShortRef = new Map();
      for (const id of observationIds) {
        const short = shortEvidenceRef(id);
        if (short === id) continue;
        // Two observations behind one short ref: name neither.
        byShortRef.set(short, byShortRef.has(short) ? null : id);
      }
    }
    return byShortRef.get(ref) || ref;
  });
}
