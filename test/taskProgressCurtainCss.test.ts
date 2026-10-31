/**
 * The Task progress row lowers and rises like a curtain. The chat shell's
 * gap under the header (taken back while the row shows) must move with the
 * row: it applies only while the row lowers or is down, never in the pose a
 * lowering starts from, and it moves only while the row does.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  resolve(here, "../addon/content/zoteroPane.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Every innermost rule: its selectors and its declarations. */
const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), (match) => ({
  selectors: match[1]
    .split(/,(?![^(]*\))/)
    .map((part) => part.replace(/\s+/g, " ").trim()),
  body: match[2],
}));

describe("task progress curtain css", function () {
  it("takes the gap under the header back only while the row lowers or is down", function () {
    const gapRules = rules.filter(
      (rule) =>
        /margin-top:\s*-(8|12)px/.test(rule.body) &&
        rule.selectors.some((selector) =>
          selector.includes("llm-task-progress-present"),
        ),
    );
    assert.lengthOf(gapRules, 2, "the sidebar's and the independent pane's");
    for (const rule of gapRules) {
      for (const selector of rule.selectors) {
        assert.match(
          selector,
          /\[data-task-progress-curtain="(opening|open)"\]/,
          selector,
        );
      }
      const states = rule.selectors.map(
        (selector) => /data-task-progress-curtain="(\w+)"/.exec(selector)![1],
      );
      assert.sameMembers(states, ["opening", "open"]);
    }
  });

  it("does not animate the header gap independently of the necessary curtain height", function () {
    assert.isEmpty(rules.filter(rule => /transition:\s*margin-top/.test(rule.body)));
    const curtain = rules.find(rule => rule.selectors.includes(".llm-task-progress-curtain"));
    assert.include(curtain!.body, "transition: height 250ms ease-out");
  });

  it("uses the sidebar header mode switch's motion", function () {
    const tokens = rules.find((rule) =>
      rule.body.includes("--llm-task-progress-curtain-duration:"),
    );
    assert.isOk(tokens);
    assert.match(tokens!.body, /--llm-task-progress-curtain-duration:\s*250ms/);
    assert.match(
      tokens!.body,
      /--llm-task-progress-curtain-ease:\s*ease-out/,
    );
  });

  it("stops every curtain motion when the system asks for reduced motion", function () {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\}\s*)\}/g;
    const blocks = Array.from(css.matchAll(reduced), (match) => match[1]);
    const curtainBlock = blocks.find((block) =>
      block.includes(".llm-task-progress-curtain"),
    );
    assert.isOk(curtainBlock, "a reduced-motion block names the curtain");
    assert.include(
      curtainBlock!,
      ".llm-chat-shell[data-task-progress-curtain]",
    );
    assert.include(curtainBlock!, ".llm-task-progress-card *");
    assert.include(curtainBlock!, "transition: none !important");
  });
});
