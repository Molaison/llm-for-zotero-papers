import { assert } from "chai";
import {
  annotationReplyBlock, listAnnotationReplyCandidates, prepareAnnotationReplyBatch,
  reparseAnnotationReplyBatch,
} from "../src/services/pdf/annotationReplyService";
import {
  getAnnotationReplyClaims, loadAnnotationReplyBatch, saveAnnotationReplyBatch,
  recordAnnotationReplyBlock,
} from "../src/utils/chatStore";
import { installAnnotationReplyTestDB } from "./helpers/annotationReplyDb";
import type { AnnotationReplyBatch } from "../src/shared/types";

const legacyBlock = (identity: string, answer: string) => "\n\n<b>AI · " + identity + "\n" + answer + "</b>";

// Zotero 10.0.6 reader 5802d14 common/editor.js:65-105 searches both
// delimiters in the SAME text node. innerText's line breaks create BR nodes.
function nativeBoldTextNodes(comment: string): string[] {
  const formatted: string[] = [];
  for (const node of comment.split(/\r\n|\r|\n/)) {
    const start = node.indexOf("<b>");
    const end = node.indexOf("</b>", start);
    if (start >= 0 && end >= 0) formatted.push(node.slice(start + 3, end));
  }
  return formatted;
}
async function rejection(action: () => Promise<unknown>): Promise<Error> {
  try {await action();} catch (error) {assert.instanceOf(error, Error);return error as Error;}
  throw new Error("Expected repair conflict");
}

describe("native annotation per-line bold and applied-block repair", () => {
  let env: ReturnType<typeof installAnnotationReplyTestDB>;
  let batch: AnnotationReplyBatch;
  const answer = "x < y & z > 0; $& is literal.\r\n\r\n第二行\n";
  let oldBlocks: string[];
  beforeEach(async () => {
    env = installAnnotationReplyTestDB();
    env.attachment(1);
    env.annotation(12, 1, "User one <i>original</i>");
    env.annotation(13, 1, "User two");
    const targets = (await listAnnotationReplyCandidates([1])).map(c => c.target!);
    batch = await prepareAnnotationReplyBatch(targets, 7, [{attachmentID:1,pageIndex:0,dataURL:"data:image/png;base64,AA==",context:"source"}]);
    batch.rawAnswer = JSON.stringify({protocol:batch.protocol,batchId:batch.id,
      replies:targets.map(target => ({identity:target.identity,version:target.version,answer}))});
    batch.status = "applied";
    oldBlocks = targets.map(target => legacyBlock(target.identity, answer));
    for (const [index,target] of targets.entries()) {
      env.items.get(target.annotationID).annotationComment += oldBlocks[index];
      await recordAnnotationReplyBlock(target.identity,target.version,oldBlocks[index]);
    }
    await saveAnnotationReplyBatch(batch);
  });
  afterEach(() => env.restore());

  it("reproduces the cross-BR failure and closes each new nonempty line within a text node", () => {
    const target = batch.targets[0];
    assert.deepEqual(nativeBoldTextNodes(oldBlocks[0]),[]);
    const block = annotationReplyBlock(target.identity,answer);
    assert.deepEqual(nativeBoldTextNodes(block),["AI 回答："+target.identity,"x < y & z > 0; $& is literal.","第二行"]);
    assert.equal(block.replace(/<\/?b>/g,""),"\n\nAI 回答："+target.identity+"\n"+answer);
    assert.deepEqual(block.match(/\r\n|\r|\n/g),("\n\nAI 回答："+target.identity+"\n"+answer).match(/\r\n|\r|\n/g));
    assert.notInclude(block,"&amp;");
  });

  it("repairs only registered blocks once while preserving batch, raw answer, user versions and comments", async () => {
    const beforeBatch = await loadAnnotationReplyBatch(batch.id);
    await Promise.all([reparseAnnotationReplyBatch(batch.id),reparseAnnotationReplyBatch(batch.id)]);
    assert.equal(env.saves(),2);
    assert.deepEqual(await loadAnnotationReplyBatch(batch.id),beforeBatch);
    for (const target of batch.targets) {
      const block = annotationReplyBlock(target.identity,answer).replace("AI 回答：", "AI · ");
      assert.equal(env.items.get(target.annotationID).annotationComment,target.comment+block);
      assert.equal((await getAnnotationReplyClaims(target.identity))[0].generated_block,block);
    }
    await reparseAnnotationReplyBatch(batch.id);
    assert.equal(env.saves(),2);
    const candidates = await listAnnotationReplyCandidates([1]);
    assert.deepEqual(candidates.map(c=>c.target!.version),batch.targets.map(t=>t.version));
    assert.isTrue(candidates.every(c=>c.blocked?.startsWith("applied")));
  });

  it("leaves canonical registered historical headings and user versions unchanged on reparse", async () => {
    for (const target of batch.targets) {
      const block = annotationReplyBlock(target.identity, answer).replace("AI 回答：", "AI · ");
      env.items.get(target.annotationID).annotationComment = target.comment + block;
      await recordAnnotationReplyBlock(target.identity, target.version, block);
    }
    const originals = batch.targets.map(t => env.items.get(t.annotationID).annotationComment);
    await reparseAnnotationReplyBatch(batch.id);
    assert.equal(env.saves(), 0);
    assert.deepEqual(batch.targets.map(t => env.items.get(t.annotationID).annotationComment), originals);
    assert.deepEqual((await listAnnotationReplyCandidates([1])).map(c => c.target!.version), batch.targets.map(t => t.version));
  });

  for (const conflict of ["user-edit","missing-block","duplicate-block","wrong-claim-owner","unknown-reply"]) {
    it("rejects "+conflict+" atomically without demoting the applied batch",async()=>{
      const target = batch.targets[1];
      const item = env.items.get(target.annotationID);
      if(conflict==="user-edit") item.annotationComment = "Edited by user"+oldBlocks[1];
      if(conflict==="missing-block") item.annotationComment = target.comment;
      if(conflict==="duplicate-block") item.annotationComment += oldBlocks[1];
      if(conflict==="wrong-claim-owner") await Zotero.DB.queryAsync(
        "UPDATE llm_for_zotero_annotation_claims SET batch_id = ? WHERE identity = ?",["another-batch",target.identity]);
      if(conflict==="unknown-reply") {
        batch.rawAnswer = batch.rawAnswer!.replace(target.identity,"1:PDF:UNKNOWN");
        await saveAnnotationReplyBatch(batch);
      }
      const originals = batch.targets.map(t=>env.items.get(t.annotationID).annotationComment);
      await rejection(()=>reparseAnnotationReplyBatch(batch.id));
      assert.equal(env.saves(),0);
      assert.deepEqual(batch.targets.map(t=>env.items.get(t.annotationID).annotationComment),originals);
      assert.equal((await loadAnnotationReplyBatch(batch.id)).status,"applied");
      for(const [index,t] of batch.targets.entries()) assert.equal((await getAnnotationReplyClaims(t.identity))[0].generated_block,oldBlocks[index]);
    });
  }

  it("rolls back claims and restores in-memory comments when native saving fails part-way",async()=>{
    env.items.get(batch.targets[1].annotationID).save = async()=>{throw new Error("native DB save failed");};
    const originals = batch.targets.map(t=>env.items.get(t.annotationID).annotationComment);
    const error = await rejection(()=>reparseAnnotationReplyBatch(batch.id));
    assert.include(error.message,"native DB save failed");
    assert.deepEqual(batch.targets.map(t=>env.items.get(t.annotationID).annotationComment),originals);
    for(const [index,t] of batch.targets.entries()) assert.equal((await getAnnotationReplyClaims(t.identity))[0].generated_block,oldBlocks[index]);
    assert.equal((await loadAnnotationReplyBatch(batch.id)).status,"applied");
  });
});
