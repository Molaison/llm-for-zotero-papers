import { assert } from "chai";
import {
  annotationReplyPrompt, normalizeAnnotationReplyPresentation, parseAnnotationReplies,
  listAnnotationReplyCandidates, prepareAnnotationReplyBatch, reparseAnnotationReplyBatch,
} from "../src/services/pdf/annotationReplyService";
import { loadAnnotationReplyBatch, saveAnnotationReplyBatch } from "../src/utils/chatStore";
import { installAnnotationReplyTestDB } from "./helpers/annotationReplyDb";
import type { AnnotationReplyBatch } from "../src/shared/types";

const response = (batch: AnnotationReplyBatch, answer: string) => JSON.stringify({
  protocol: batch.protocol, batchId: batch.id,
  replies: batch.targets.map(t => ({identity:t.identity, version:t.version, answer})),
}, null, 2);
const markdownArrays = (json: string) => json.replace('"replies": [', '"replies": \\[').replace(/\n  \]\n}$/, "\n  \\]\n}");

describe("annotation JSON Markdown presentation normalization", () => {
  let env: ReturnType<typeof installAnnotationReplyTestDB>;
  let batch: AnnotationReplyBatch;
  beforeEach(async () => {
    env = installAnnotationReplyTestDB();
    env.attachment(1); env.annotation(12, 1, "Question one"); env.annotation(13, 1, "Question two");
    const targets = (await listAnnotationReplyCandidates([1])).map(c => c.target!);
    batch = await prepareAnnotationReplyBatch(targets, 7, [{attachmentID:1, pageIndex:0, dataURL:"data:image/png;base64,AA==", context:"source"}]);
  });
  afterEach(() => env.restore());
  it("removes the observed single presentation escape around the replies array", () => {
    const json = response(batch, "Explanation");
    const raw = markdownArrays(json);
    assert.include(raw, '"replies": \\[');
    assert.throws(() => JSON.parse(raw));
    assert.equal(normalizeAnnotationReplyPresentation(raw), json);
    assert.lengthOf(parseAnnotationReplies(batch, raw), 2);
  });
  it("accepts exactly one JSON code fence and requests that presentation for future answers", () => {
    assert.lengthOf(parseAnnotationReplies(batch, "```json\n"+response(batch,"Answer")+"\n```"),2);
    assert.include(annotationReplyPrompt(batch), "exactly ONE fenced ```json code block");
    assert.throws(() => parseAnnotationReplies(batch, "extra prose\n```json\n"+response(batch,"Answer")+"\n```"));
  });
  it("preserves every byte inside JSON strings including backslashes, quotes and math", () => {
    const answer = String.raw`\[x < y\] & C:\tmp\file; quote "[value]" and \\`;
    const json = response(batch, answer);
    assert.equal(normalizeAnnotationReplyPresentation(markdownArrays(json)), json);
    assert.equal(parseAnnotationReplies(batch, markdownArrays(json))[0].answer, answer);
  });
  it("does not repair invalid string escapes or unrelated malformed JSON", () => {
    assert.throws(() => parseAnnotationReplies(batch, response(batch,"PLACEHOLDER").replace("PLACEHOLDER", String.raw`\[invalid string\]`)));
    assert.throws(() => parseAnnotationReplies(batch, "\\"+response(batch,"Answer")));
  });
  it("still rejects an unknown identity after normalizing presentation", () => {
    const raw = markdownArrays(response(batch,"Answer").replace(batch.targets[0].identity,"1:OTHER:UNSELECTED"));
    assert.throws(() => parseAnnotationReplies(batch,raw),"identity");
    assert.equal(env.saves(),0);
  });
  it("recovers the stored invalid batch without replacing rawAnswer or writing twice", async () => {
    const raw = markdownArrays(response(batch,"Recovered complete answer"));
    batch.rawAnswer = raw; batch.status = "invalid"; batch.error = "original JSON.parse error";
    await saveAnnotationReplyBatch(batch);
    const applied = await reparseAnnotationReplyBatch(batch.id);
    assert.equal(applied.id,batch.id); assert.equal(applied.status,"applied");
    assert.equal(applied.rawAnswer,raw); assert.equal(env.saves(),2);
    await reparseAnnotationReplyBatch(batch.id);
    assert.equal(env.saves(),2);
    assert.equal((await loadAnnotationReplyBatch(batch.id)).rawAnswer,raw);
  });
});
