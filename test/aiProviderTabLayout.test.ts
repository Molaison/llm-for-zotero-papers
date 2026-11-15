import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

/**
 * The AI Providers tab used to stack always-open cards, each with its own
 * inline card/label/input style constants, a hand-drawn divider, an uppercase
 * "MODEL NAMES" heading and a destructive × in the title bar. These
 * assertions pin the shape that replaced it: the Agent tab's collapsible row,
 * rendered from the Agent tab's own stylesheet.
 */

describe("AI Providers tab layout", function () {
  it("dresses the rows in icons the plugin already ships", function () {
    const markup = source("addon/content/preferences.xhtml");
    const flat = markup.replace(/\s+/g, " ");

    // Codex retains its existing logo. Custom API and generic WebChat
    // retain the colors of the user-selected artwork instead of masking it.
    assert.include(
      flat,
      '.llm-pref-row-icon--codex { background-image: url("chrome://__addonRef__/content/icons/codex-logo.svg"); }',
    );
    assert.include(
      flat,
      'url("chrome://__addonRef__/content/icons/webchat-connection.svg")',
    );
    assert.include(
      flat,
      'url("chrome://__addonRef__/content/icons/custom-api.svg")',
    );
    assert.include(
      flat,
      '.llm-pref-row-icon--provider { background-image: url("chrome://__addonRef__/content/icons/custom-api.svg"); }',
    );
    assert.include(
      flat,
      '.llm-pref-row-icon--webchat { background-image: url("chrome://__addonRef__/content/icons/webchat-connection.svg"); }',
    );
    // Zotero inlines this markup into its own document, so relative URLs die.
    assert.notMatch(markup, /url\("icons\//);

    // Mask-tinted icons sit at full strength in the row title's own colour.
    // Dimmed with an opacity they washed out against the head, and `Field`
    // is the near-black input background in dark chrome, not a light value.
    for (const modifier of ["notes"]) {
      const at = flat.indexOf(`.llm-pref-row-icon--${modifier} {`);
      assert.isAtLeast(at, 0, modifier);
      const rule = flat.slice(at, flat.indexOf("}", at));
      assert.include(rule, "background-color: FieldText", modifier);
      assert.notInclude(rule, "opacity:", modifier);
    }
  });

  it("paints its cards so they sit above the pane Zotero actually draws", function () {
    // Only the shared stylesheet is in scope here. The Customization and
    // MinerU tabs still carry their own inline `--stroke-secondary` borders;
    // those are pre-existing and untouched.
    const markup = source("addon/content/preferences.xhtml");
    const flat = markup
      .slice(markup.indexOf("<html:style>"), markup.indexOf("</html:style>"))
      // Comments explain why these tokens exist and name the ones they
      // replaced; the assertions below are about declarations, not prose.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\s+/g, " ");

    // Zotero defines --fill-primary and --fill-secondary but NOT
    // --stroke-secondary, so `var(--stroke-secondary, #c8c8c8)` always
    // resolved to light grey — a harsh border on a dark pane. And the `Field`
    // system colour is near-black in dark chrome, so a card painted with it
    // sank below the pane instead of sitting above it.
    assert.notInclude(flat, "--stroke-secondary");
    assert.notInclude(flat, "background: Field");

    // Zotero paints the preferences content area with
    // `#prefs-outer-container { background-color: var(--material-sidepane) }`
    // — #303030 dark / #f2f2f2 light. A card has to sit ABOVE that, so these
    // are literal values chosen against it: --material-mix-quinary is #2b2b2b
    // dark (darker than the pane) and #f2f2f2 light (identical to it), so a
    // card painted from that token sinks or vanishes.
    // All four tokens live on the prefs root, so every tab draws from them —
    // including the Embedding Provider card on Customization, which mirrors a
    // provider row: head in the chrome colour over a body in the surface.
    assert.include(
      flat,
      "#__addonRef__-prefs { --llm-pref-surface: #f4f4f4; --llm-pref-head: #ffffff; --llm-pref-field: #ffffff; --llm-pref-stroke: #dadada; }",
    );
    assert.include(
      flat,
      "@media (prefers-color-scheme: dark) { #__addonRef__-prefs { --llm-pref-surface: #3a3a3a; --llm-pref-head: #282828; --llm-pref-field: #282828; --llm-pref-stroke: #4f4f4f; } }",
    );
    // The panel itself now carries layout only.
    assert.include(
      flat,
      ".llm-pref-panel { display: flex; flex-direction: column; gap: 14px; }",
    );
    const script = source("src/modules/preferenceScript.ts");
    assert.include(
      script,
      "background: var(--llm-pref-surface); overflow: hidden;",
    );
    assert.include(script, "background: var(--llm-pref-head);");
    assert.include(flat, "#__addonRef__-prefs .llm-pref-fields :is(");
    // Inline styles beat any selector, so no INPUT may declare these itself.
    // (A button and the MinerU context menu still set `background: Field`
    // deliberately — they are not fields and keep Zotero's own chrome.)
    const markupBody = markup.slice(markup.indexOf("</html:style>"));
    const fields =
      markupBody.match(/<html:(?:input|select|textarea)\b[\s\S]*?>/g) || [];
    assert.isAtLeast(fields.length, 40, "found the pane's fields");
    for (const field of fields) {
      assert.notInclude(field, "background: Field");
      assert.notInclude(field, "--stroke-secondary");
    }
    // The script draws its edges from the token too. (A comment there still
    // names --stroke-secondary to explain why it was abandoned, so match the
    // var() call rather than the bare name.)
    assert.notInclude(script, "var(--stroke-secondary");

    // The card body and the fields inside it are separate tokens. Light draws
    // fields lighter than the body so they stand out; dark draws them darker,
    // for the same separation in the direction that suits it. Pointing both
    // at one value, as dark used to, made fields invisible.
    for (const [selector, token] of [
      [".llm-pref-panel .llm-pref-row {", "var(--llm-pref-surface)"],
      [
        ".llm-pref-panel .llm-pref-input, .llm-pref-panel .llm-pref-select {",
        "var(--llm-pref-field)",
      ],
      [".llm-pref-panel .llm-pref-button {", "var(--llm-pref-field)"],
    ] as const) {
      const at = flat.indexOf(selector);
      assert.isAtLeast(at, 0, selector);
      const rule = flat.slice(at, flat.indexOf("}", at));
      assert.include(rule, `background: ${token}`, selector);
    }
    // The card must never be painted from a token that tracks the pane itself.
    assert.notInclude(flat, "--llm-pref-surface: var(--material-mix-quinary");

    // The row head is a darker title bar, like the Embedding Provider card.
    // It is defined on the shared panel scope, so both tabs get it.
    // The head is deliberately NOT tied to the selected tab: the tab keeps
    // Zotero's own `background: Field` so it reads as chrome, while the head
    // belongs to the card. #282828 sits 8 levels below the #303030 pane —
    // darker read as a hole in the card, lighter vanished into the pane.
    assert.include(flat, "--llm-pref-head: #ffffff;");
    assert.include(flat, "--llm-pref-head: #282828;");
    assert.notInclude(flat, "--llm-pref-chrome");
    const preferenceScript = source("src/modules/preferenceScript.ts");
    assert.include(preferenceScript, 'btn.style.background = "Field"');
    const headRule = flat.slice(
      flat.indexOf(".llm-pref-panel .llm-pref-row-head {"),
      flat.indexOf("}", flat.indexOf(".llm-pref-panel .llm-pref-row-head {")),
    );
    assert.include(headRule, "background: var(--llm-pref-head)");

    // Every edge on both tabs comes from the one stroke token.
    for (const rule of [
      ".llm-pref-panel .llm-pref-row {",
      ".llm-pref-panel .llm-pref-input, .llm-pref-panel .llm-pref-select {",
      ".llm-pref-panel .llm-pref-button {",
    ]) {
      const start = flat.indexOf(rule);
      assert.isAtLeast(start, 0, rule);
      const body = flat.slice(start, flat.indexOf("}", start));
      assert.include(body, "var(--llm-pref-stroke)", rule);
    }
  });
});
