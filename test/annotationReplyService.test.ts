import { assert } from "chai";
import { installAnnotationReplyTestDB } from "./helpers/annotationReplyDb";
import {
  listAnnotationReplyCandidates, prepareAnnotationReplyBatch, completeAnnotationReplyBatch,
  reparseAnnotationReplyBatch, settleAnnotationReplyBatch, parseAnnotationReplies,
  annotationReplyPrompt, userAnnotationComment,
} from "../src/services/pdf/annotationReplyService";
import { loadAnnotationReplyBatch } from "../src/utils/chatStore";
import { drawPdfAnnotationLabels, transformAnnotationRect } from "../src/services/pdf/pdfPageCapture";
import type { AnnotationReplyBatch } from "../src/shared/types";

const pages = [{attachmentID:1,pageIndex:0,dataURL:"data:image/png;base64,AA==",context:"surrounding source text"}];
const response = (batch:AnnotationReplyBatch) => ({protocol:batch.protocol,batchId:batch.id,replies:batch.targets.map(t=>({identity:t.identity,version:t.version,answer:"Explanation: x < y & z > 0."}))});
async function rejects(fn:()=>Promise<unknown>, message?:string) {
  let error:unknown;try{await fn();}catch(e){error=e;}assert.instanceOf(error,Error);if(message)assert.include(String(error),message);
}

describe("PDF annotation replies with real SQLite ledger", function() {
  let env:ReturnType<typeof installAnnotationReplyTestDB>;
  beforeEach(()=>{env=installAnnotationReplyTestDB();env.attachment(1);});
  afterEach(()=>env.restore());
  const prepare = async()=>prepareAnnotationReplyBatch((await listAnnotationReplyCandidates([1])).filter(c=>!c.blocked).map(c=>c.target!),7,pages);
  it("filters on user comment, not quoted annotationText; scopes identity by library and PDF",async()=>{
    env.annotation(11,1,"");env.annotation(12,1,"Question");
    env.attachment(2,2,"PDF1");env.annotation(22,2,"Question","ANN12");
    env.attachment(3,1,"PDF3");env.annotation(32,3,"Question","ANN12");
    const targets=(await listAnnotationReplyCandidates([1,2,3])).map(c=>c.target!);
    assert.lengthOf(targets,3);assert.equal(new Set(targets.map(t=>t.identity)).size,3);
  });
  it("atomically claims versions across conversations and blocks uncertain resends",async()=>{
    env.annotation(12,1,"Question");const batch=await prepare();
    await rejects(()=>prepareAnnotationReplyBatch(batch.targets,99,pages),"不会重复发送");
    await settleAnnotationReplyBatch(batch.id,true);
    assert.equal((await loadAnnotationReplyBatch(batch.id)).status,"uncertain");
    await rejects(()=>prepareAnnotationReplyBatch(batch.targets,99,pages));
    assert.include((await listAnnotationReplyCandidates([1]))[0].blocked!,"uncertain");
  });
  it("releases only a provably undispatched reservation",async()=>{
    env.annotation(12,1,"Question");const batch=await prepare();
    await settleAnnotationReplyBatch(batch.id,false);
    assert.isUndefined((await listAnnotationReplyCandidates([1]))[0].blocked);
    assert.equal((await prepare()).status,"inflight");
  });
  it("preserves native user formatting and math, writes once even for concurrent reparses, and excludes AI from version",async()=>{
    const item=env.annotation(12,1,"User <i>question</i>: a < b & c > 0");const original=item.annotationComment;
    const batch=await prepare();const raw=JSON.stringify(response(batch));
    await completeAnnotationReplyBatch(batch.id,raw);
    const comment=item.annotationComment;
    await Promise.all([reparseAnnotationReplyBatch(batch.id),completeAnnotationReplyBatch(batch.id,raw)]);
    assert.equal(env.saves(),1);assert.equal(item.annotationComment,comment);assert.isTrue(comment.startsWith(original));
    assert.include(comment,"<b>AI 回答：");assert.include(comment,"x < y & z > 0");assert.notInclude(comment,"&amp;");
    const candidate=(await listAnnotationReplyCandidates([1]))[0];
    assert.equal(candidate.target!.version,batch.targets[0].version);assert.isString(candidate.blocked);
    item.annotationComment += "\nUser follow-up";env.annotation(13,1,"New question");
    const next=(await listAnnotationReplyCandidates([1])).filter(c=>!c.blocked);
    assert.lengthOf(next,2);assert.notEqual(next[0].target!.version,batch.targets[0].version);
    assert.notInclude(next[0].target!.comment,"Explanation");
  });
  for (const kind of ["unknown","duplicate","version","protocol","batch","injection","missing"]) {
    it(`rejects ${kind} replies before any write and retains complete raw answer`,async()=>{
      env.annotation(12,1,"Question one");env.annotation(13,1,"Question two");const batch=await prepare();
      const value=response(batch);
      if(kind==="unknown")value.replies[0].identity="1:OTHER:OTHER";
      if(kind==="duplicate")value.replies[1]=value.replies[0];
      if(kind==="version")value.replies[0].version="old";
      if(kind==="protocol")value.protocol="wrong" as any;
      if(kind==="batch")value.batchId="wrong";
      if(kind==="injection")value.replies[0].answer="<b>injected</b>";
      if(kind==="missing")value.replies.pop();
      const raw=JSON.stringify(value);await rejects(()=>completeAnnotationReplyBatch(batch.id,raw));
      assert.equal(env.saves(),0);assert.equal((await loadAnnotationReplyBatch(batch.id)).rawAnswer,raw);
      await rejects(()=>reparseAnnotationReplyBatch(batch.id));assert.equal(env.saves(),0);
    });
  }
  it("rejects a stale edit or deleted item without writing any selected sibling",async()=>{
    const one=env.annotation(12,1,"Question one");const two=env.annotation(13,1,"Question two");
    const batch=await prepare();two.annotationComment="Changed by user";
    await rejects(()=>completeAnnotationReplyBatch(batch.id,JSON.stringify(response(batch))),"旧版本");
    assert.equal(env.saves(),0);assert.equal(one.annotationComment,"Question one");
  });
  it("survives process-style cache loss and reparses stored answers without a model",async()=>{
    env.annotation(12,1,"Question");const batch=await prepare();
    const raw="```json\n"+JSON.stringify(response(batch))+"\n```";
    await completeAnnotationReplyBatch(batch.id,raw);
    assert.equal((await reparseAnnotationReplyBatch(batch.id)).status,"applied");assert.equal(env.saves(),1);
  });
  it("includes selected source, exact identities and page context in model prompt",async()=>{
    env.annotation(12,1,"Why?");const batch=await prepare();const prompt=annotationReplyPrompt(batch);
    for(const text of [batch.targets[0].identity,batch.targets[0].version,"Why?","source quote","surrounding source text"])assert.include(prompt,text);
  });
});

describe("PDF.js annotation coordinates",()=>{
  it("transforms crop offset and 90/270 degree rotation instead of inventing positions",()=>{
    assert.deepEqual(transformAnnotationRect([20,40,50,60],[0,2,2,0,-40,-20]),[40,20,80,80]);
    assert.deepEqual(transformAnnotationRect([20,40,50,60],[0,-2,-2,0,200,180]),[80,80,120,140]);
  });
  it("paints only explicitly selected identity labels and rejects out-of-crop rectangles",()=>{
    const labels:string[]=[];let rects=0;
    const ctx={save(){},restore(){},fillRect(){},strokeRect(){rects++;},beginPath(){},moveTo(){},lineTo(){},stroke(){},fillText(text:string){labels.push(text);}} as any;
    drawPdfAnnotationLabels(ctx,{transform:[1,0,0,-1,-10,110],width:200,height:200},[{identity:"1:PDF:WITHCOMMENT",rects:[[20,20,50,40]]}]);
    assert.deepEqual(labels,["1:PDF:WITHCOMMENT"]);assert.equal(rects,1);
    assert.throws(()=>drawPdfAnnotationLabels(ctx,{transform:[1,0,0,1,0,0],width:100,height:100},[{identity:"bad",rects:[[101,10,110,20]]}]),"裁剪");
  });
  it("removes only a recorded exact generated block, not user-authored bold",()=>{
    assert.equal(userAnnotationComment("User <b>own</b>\nAI",["\nAI"]),"User <b>own</b>");
  });
});
