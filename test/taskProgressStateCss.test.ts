/**
 * The Task progress row's ring, pill and Steps header for the states a run's
 * outcome ledger adds. Each is drawn with a look the row already has: a
 * selector on an existing rule, never a new color or class.
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
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim()),
  body: match[2],
}));

function ruleWith(selector: string) {
  const found = rules.filter((rule) => rule.selectors.includes(selector));
  assert.lengthOf(found, 1, `one rule has ${selector}`);
  return found[0];
}

const row = (state: string, part: string) =>
  `.llm-task-progress[data-state="${state}"] .llm-task-progress-${part}`;

describe("task progress looks for outcome states", function () {
  it("spins the ring while a run waits on the user, as while it works", function () {
    assert.include(
      ruleWith(row("working", "ring-arc")).selectors,
      row("waiting", "ring-arc"),
    );
    assert.include(
      ruleWith(row("working", "ring-track")).selectors,
      row("waiting", "ring-track"),
    );
  });

  it("shows ✓ for a run that completed with exceptions", function () {
    assert.include(
      ruleWith(row("completed", "badge-done")).selectors,
      row("completed_with_exceptions", "badge-done"),
    );
    assert.include(
      ruleWith(row("completed", "ring-track")).selectors,
      row("completed_with_exceptions", "ring-track"),
    );
  });

  it("draws an interrupted or blocked run's ring as a cancelled one", function () {
    const dashed = ruleWith(row("cancelled", "ring-base")).selectors;
    assert.include(dashed, row("interrupted", "ring-base"));
    assert.include(dashed, row("blocked", "ring-base"));
  });

  it("gives an outcome ledger's waiting header the amber look, and leaves plan headers as they were", function () {
    assert.include(
      ruleWith('.llm-plan-status[data-status="partial"]').selectors,
      '[data-llm-checklist-source="outcomes"] .llm-plan-status[data-status="waiting_for_user"]',
    );
    assert.isFalse(
      rules.some((rule) =>
        rule.selectors.includes(
          '.llm-plan-status[data-status="waiting_for_user"]',
        ),
      ),
      "a plan's own waiting header keeps its look",
    );
  });

  it("tones the row pill amber for the new endings and for waiting", function () {
    const amber = ruleWith(
      '.llm-task-progress-pill[data-tone="completed_with_exceptions"]',
    );
    for (const tone of ["blocked", "waiting", "interrupted"]) {
      assert.include(
        amber.selectors,
        `.llm-task-progress-pill[data-tone="${tone}"]`,
      );
    }
    assert.include(amber.body, "#d58a22");
  });
});
