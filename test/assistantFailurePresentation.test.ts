import { assert } from "chai";
import { readFileSync } from "node:fs";
import { assistantFailureTitle } from "../src/modules/contextPanel/assistantFailurePresentation";
import { t } from "../src/utils/i18n";
import type { Message } from "../src/modules/contextPanel/types";

const notice = "Error: ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.";
const message = (fields: Partial<Message> = {}): Message => ({role:"assistant",text:notice,timestamp:1,...fields});
describe("historical assistant failure presentation", () => {
  it("recognizes only the confirmed complete legacy notice without rewriting its bytes", () => {
    const saved = message(); const before = JSON.stringify(saved);
    assert.equal(assistantFailureTitle(saved), t("Model controls unavailable"));
    assert.equal(JSON.stringify(saved), before);
    for (const text of ["Error: estimation is unbiased", `Quoted notice: ${notice}`, `${notice}\nHere is an explanation`, "```\n"+notice+"\n```"])
      assert.isUndefined(assistantFailureTitle(message({text})));
    assert.isUndefined(assistantFailureTitle(message({completionStatus:"complete"})));
    assert.isUndefined(assistantFailureTitle(message({streaming:true})));
    assert.isUndefined(assistantFailureTitle(message({role:"user"})));
  });
  it("uses persisted failure fields independently of model prose, without reclassifying output limits", () => {
    for (const fields of [{webchatRunState:"error"}, {webchatCompletionReason:"error"}, {completionStatus:"blocked"}] as Partial<Message>[])
      assert.equal(assistantFailureTitle(message({text:"Original preserved reply",...fields})),t("Answer incomplete"));
    assert.isUndefined(assistantFailureTitle(message({text:"Partial answer",completionStatus:"incomplete",completionReason:"output_limit"})));
    const chat = readFileSync("src/modules/contextPanel/chat.ts","utf8");
    assert.include(chat,"const failureTitle = assistantFailureTitle(msg)");
    assert.include(chat,'label.setAttribute("role", "alert")');
    const css = readFileSync("addon/content/zoteroPane.css","utf8");
    assert.match(css,/\.llm-answer-error > \.llm-answer-label::before[^}]+content: "!"/);
    assert.include(css,"color: var(--llm-red11)");
  });
});
