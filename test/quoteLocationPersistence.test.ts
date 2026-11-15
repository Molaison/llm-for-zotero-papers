import { assert } from "chai";
import {
  buildQuoteCitation,
  hasVerifiedQuoteLocation,
  normalizeQuoteCitations,
} from "../src/services/quotes/quoteCitations";
import {
  applyQuoteLocationWrites,
  collectQuoteLocationWrites,
  hasPersistableQuoteLocation,
  mergeQuoteLocationWritesIntoStoredJson,
  restoreQuoteSourceFileStates,
  withoutPersistedQuoteLocation,
  type QuoteCitationWithFileState,
} from "../src/services/quotes/quoteLocationPersistence";
import type { QuoteCitation } from "../src/shared/types";

const QUOTE =
  "Noise correlation changed more favorably for neuron pairs with high signal correlation.";
const OTHER =
  "Place cells in CA1 remapped across days when the animals explored a novel environment.";
const FILE = { size: 1234, mtime: 1_700_000_000_000 };

/** The record as JSON stores it: undefined fields dropped. */
function asStored<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A record as an agent turn stores it: no verified PDF location. */
function stored(quoteText = QUOTE, contextItemId = 5001): QuoteCitation {
  return buildQuoteCitation({
    quoteText,
    citationLabel: "(Eppler et al., 2026)",
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
    contextItemId,
    itemId: 55001,
    sourceFingerprint: "fnv1a32-deadbeef",
    sourceSectionLabel: "Results",
  })!;
}

/** The same record as the display gate finalizes it on PDF page text. */
function located(
  base: QuoteCitation,
  overrides: Partial<QuoteCitation> = {},
): QuoteCitation {
  return {
    id: base.id,
    quoteText: base.quoteText,
    citationLabel: base.citationLabel,
    sourceMatchText: base.quoteText,
    sourceMatchKind: "exact",
    sourceMatchSource: "pdf-page-text",
    contextItemId: base.contextItemId,
    itemId: base.itemId,
    sourceFingerprint: "page-text:5akwys",
    sourceMatchPageOccurrence: 0,
    pageHintIndex: 3,
    pageHintLabel: "4",
    ...overrides,
  };
}

describe("quote location persistence helpers", function () {
  it("accepts gate locations on page text and pdf.js fingerprints only", function () {
    const base = stored();
    assert.isTrue(hasPersistableQuoteLocation(located(base)));
    assert.isTrue(
      hasPersistableQuoteLocation(
        located(base, { sourceFingerprint: "pdfjs:abc123" }),
      ),
    );
    assert.isFalse(
      hasPersistableQuoteLocation(
        located(base, { sourceFingerprint: "fnv1a32-0badf00d" }),
      ),
    );
    assert.isFalse(
      hasPersistableQuoteLocation(
        located(base, { sourceFingerprint: "unknown-source" }),
      ),
    );
    assert.isFalse(hasPersistableQuoteLocation(base));
  });

  it("collects a write only for a located record whose id is already stored", function () {
    const first = stored();
    const second = stored(OTHER);
    const unknown = stored(OTHER, 6001);
    const writes = collectQuoteLocationWrites({
      storedQuoteCitations: [first, second],
      finalizedQuoteCitations: [
        located(first),
        // Located, but on MinerU text: never persisted as a location.
        located(second, { sourceFingerprint: "fnv1a32-0badf00d" }),
        // Located, but this message never stored the id.
        located(unknown),
      ],
      fileStates: new Map([
        [5001, FILE],
        [6001, FILE],
      ]),
    });
    assert.deepEqual(writes, [
      {
        id: first.id,
        contextItemId: 5001,
        location: {
          sourceMatchSource: "pdf-page-text",
          sourceMatchText: QUOTE,
          sourceMatchKind: "exact",
          sourceFingerprint: "page-text:5akwys",
          pageHintIndex: 3,
          pageHintLabel: "4",
          sourceMatchPageOccurrence: 0,
        },
        sourceFileState: FILE,
      },
    ]);
  });

  it("collects nothing without the attachment's file state", function () {
    const first = stored();
    assert.deepEqual(
      collectQuoteLocationWrites({
        storedQuoteCitations: [first],
        finalizedQuoteCitations: [located(first)],
        fileStates: new Map(),
      }),
      [],
    );
  });

  it("collects nothing when the stored record already holds the same location and file state", function () {
    const first = stored();
    const already: QuoteCitationWithFileState = {
      ...located(first),
      sourceSectionLabel: "Results",
      sourceFileState: FILE,
    };
    assert.deepEqual(
      collectQuoteLocationWrites({
        storedQuoteCitations: [already],
        finalizedQuoteCitations: [located(first)],
        fileStates: new Map([[5001, FILE]]),
      }),
      [],
    );
  });

  it("refuses a location found in another attachment than the stored record's", function () {
    const first = stored();
    assert.deepEqual(
      collectQuoteLocationWrites({
        storedQuoteCitations: [first],
        finalizedQuoteCitations: [located(first, { contextItemId: 6001 })],
        fileStates: new Map([[6001, FILE]]),
      }),
      [],
    );
  });

  it("merges location fields into stored JSON, leaving every other field and record as written", function () {
    const first = stored();
    const second = stored(OTHER);
    const rawSecond = { ...second, futureField: "kept" };
    const json = JSON.stringify([first, rawSecond]);
    const [write] = collectQuoteLocationWrites({
      storedQuoteCitations: [first, second],
      finalizedQuoteCitations: [located(first)],
      fileStates: new Map([[5001, FILE]]),
    });
    const next = mergeQuoteLocationWritesIntoStoredJson(json, [write]);
    assert.isString(next);
    const parsed = JSON.parse(next!) as Array<Record<string, unknown>>;
    assert.deepEqual(parsed[1], asStored(rawSecond), "other record kept");
    assert.equal(
      JSON.stringify(parsed[1]),
      JSON.stringify(rawSecond),
      "other record byte-equal",
    );
    assert.deepEqual(parsed[0], {
      ...asStored(first),
      sourceMatchSource: "pdf-page-text",
      sourceMatchText: QUOTE,
      sourceMatchKind: "exact",
      sourceFingerprint: "page-text:5akwys",
      pageHintIndex: 3,
      pageHintLabel: "4",
      sourceMatchPageOccurrence: 0,
      sourceFileState: FILE,
    });
    assert.equal(
      mergeQuoteLocationWritesIntoStoredJson(next, [write]),
      null,
      "a repeat write changes nothing",
    );
  });

  it("drops a stale page label the new location does not carry", function () {
    const first = { ...located(stored()), pageHintLabel: "old" };
    const [write] = collectQuoteLocationWrites({
      storedQuoteCitations: [first],
      finalizedQuoteCitations: [
        located(stored(), { pageHintLabel: undefined }),
      ],
      fileStates: new Map([[5001, FILE]]),
    });
    const parsed = JSON.parse(
      mergeQuoteLocationWritesIntoStoredJson(JSON.stringify([first]), [write])!,
    );
    assert.notProperty(parsed[0], "pageHintLabel");
  });

  it("writes nothing into a row with no matching record or unreadable JSON", function () {
    const [write] = collectQuoteLocationWrites({
      storedQuoteCitations: [stored()],
      finalizedQuoteCitations: [located(stored())],
      fileStates: new Map([[5001, FILE]]),
    });
    assert.isNull(
      mergeQuoteLocationWritesIntoStoredJson(JSON.stringify([stored(OTHER)]), [
        write,
      ]),
    );
    assert.isNull(mergeQuoteLocationWritesIntoStoredJson("{not json", [write]));
    assert.isNull(mergeQuoteLocationWritesIntoStoredJson(null, [write]));
  });

  it("applies the same merge to the in-memory records", function () {
    const first = stored();
    const second = stored(OTHER);
    const writes = collectQuoteLocationWrites({
      storedQuoteCitations: [first, second],
      finalizedQuoteCitations: [located(first)],
      fileStates: new Map([[5001, FILE]]),
    });
    const next = applyQuoteLocationWrites([first, second], writes)!;
    assert.strictEqual(next[1], second, "untouched record kept by identity");
    assert.deepEqual(
      asStored(next[0]),
      JSON.parse(
        mergeQuoteLocationWritesIntoStoredJson(
          JSON.stringify([first, second]),
          writes,
        )!,
      )[0],
    );
    assert.isTrue(hasVerifiedQuoteLocation(next[0]));
  });

  it("restores the file state that citation normalization drops on load", function () {
    const raw = [{ ...located(stored()), sourceFileState: FILE }];
    const normalized = normalizeQuoteCitations(raw);
    assert.notProperty(normalized[0], "sourceFileState");
    const restored = restoreQuoteSourceFileStates(raw, normalized);
    assert.deepEqual(
      (restored[0] as QuoteCitationWithFileState).sourceFileState,
      FILE,
    );
    assert.deepEqual(
      restoreQuoteSourceFileStates(
        [{ ...located(stored()), sourceFileState: { size: "x" } }],
        normalized,
      ),
      normalized,
      "a malformed file state is ignored",
    );
  });

  it("strips only the page occurrence and file state, so the record stays minted", function () {
    const record: QuoteCitationWithFileState = {
      ...located(stored()),
      sourceFileState: FILE,
    };
    const stripped = withoutPersistedQuoteLocation(record);
    assert.isFalse(hasVerifiedQuoteLocation(stripped));
    assert.notProperty(stripped, "sourceFileState");
    assert.notProperty(stripped, "sourceMatchPageOccurrence");
    assert.equal(stripped.pageHintIndex, 3);
    assert.lengthOf(
      normalizeQuoteCitations([stripped]),
      1,
      "normalization keeps it",
    );
    assert.property(record, "sourceFileState", "input not mutated");
  });
});
