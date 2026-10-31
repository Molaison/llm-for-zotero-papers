# Production UI and interaction audit

Phase 1 read-only review, 2026-10-28. No production interface files changed. No `AGENTS.md` was found in the checkout or its workspace parent. The explicit constraints in `src/modules/contextPanel/README.md` apply: preserve exported signatures, DOM IDs/class names, preference keys and persistence schemas.

## Real implementation and entry points

This is a Zotero add-on using TypeScript and namespaced HTML/XUL/XHTML, not a React app.

| Surface | Production files | Responsibility |
| --- | --- | --- |
| Reader/library sidebar | `src/modules/contextPanel/index.ts`, `buildUI.ts` | Zotero registration, actual static DOM builder |
| Conversation behavior | `setupHandlers.ts`, `setupHandlers/domRefs.ts`, `chat.ts` | Existing event wiring, stable ID contract, conversations and streaming |
| Shared style | `addon/content/zoteroPane.css` | Radix colors, host font scaling, menus, messages, composer, standalone |
| Standalone window | `addon/content/standaloneChat.xhtml`, `standaloneWindow.ts`, `standaloneSidebarView.ts` | Main chat window, native title-bar controls, history/skills/preferences rail |
| Native pane layout | `sidebarLayout.ts`, `dedicatedChatPane.ts`, `sidebarModeSwitch.ts` | Independent/Stacked native ownership and Paper/Library switch |
| Preferences | `addon/content/preferences.xhtml`, `src/modules/preferenceScript.ts`, `src/modules/preferences/` | Five persistent tab keys; runtime, model, agent, PDF/context and usage configuration |
| Rich answers | `renderedMarkdown.ts`, `agentTrace/`, `taskProgress/`, `sourcePopover.ts`, `citation*` | Markdown/KaTeX/Mermaid/charts, sources, progress, approval/review cards |

There is a second `src/modules/contextPanel/addon/content/zoteroPane.css` path; the bundled shared entry is `addon/content/zoteroPane.css`. Avoid editing the nested copy by accident.

## Existing design tokens and reuse

The first 140 lines of the shared stylesheet already define 12-step light/dark Radix slate/indigo/red/green/amber scales. Semantic aliases include `--llm-ui-surface`, `--llm-ui-ink`, `--llm-ui-muted`, `--llm-ui-accent`; type tokens `--llm-text-small/control/body/title` preserve host font scaling and minimum 12/14/16px sizes. Dark themes are selected through `.window-is-dark`, `:root[lwtheme-brighttext]`, or `[data-standalone-theme="dark"]`.

Reuse these tokens. Consolidate the previous `UI REDESIGN HILL CLIMB` suffix instead of appending a second incompatible system. Its literal RGB shadows, 1px borders and middot separator currently conflict with the checked-in `test/readingSidebarDesignInventory.test.ts` contract. This is a source finding, not a claim that a baseline test has already run.

## Highest risks

1. `getPanelDomRefs()` queries roughly 120 stable IDs. A prettier DOM that drops or duplicates one of these can silently break send, upload, retry, history, model/reasoning, permission or source actions. Preserve IDs and menu action attributes.
2. The real sidebar is narrower than the Zotero window. Existing layout uses container queries, while the prior redesign suffix uses viewport `@media (max-width: 420px/520px)`. Those suffixes will usually not activate for a 360px sidebar in a 1400px Zotero window. Use the actual panel/container width for sidebar adaptation.
3. Independent/Stacked presentation is live and must not rebuild/reparent the conversation host. Both mode controls exist in DOM; root `data-llm-sidebar-layout` picks which is visible. Native pane ownership preserves per-tab drafts, reader selection and conversation identity.
4. Scope bar metadata is populated during `buildUI()`. Validate Paper→Library→Paper, note scope, retained reader tabs and rename behavior; do not assume the static scope label follows every in-place lifecycle path.
5. Status currently has both a formerly visually-hidden `.llm-status` and a redesign `.llm-run-status-strip` override. Empty Ready is intentional; errors, warnings, sending, recovered status and cancel remain meaningful. A pill with no status must not consume model/send width.
6. Moving runtime controls/usage/permissions into disclosure changes discoverability and may conflict with pinned parent relationships in existing tests. Runtime selection, agent mode and permission mode are distinct state dimensions.
7. Context previews can contain long quotes, multiple documents, many screenshots and upload state. Cap scroll region without clipping the context menu or making the textarea/send inaccessible. Drag-and-drop and paste behavior depend on existing handlers.
8. Standalone collapsed chrome moves native window controls and collapse toggle to the tab-row host. Preserve this handoff and flyout state; keeping a visible rail-shaped gap would regress existing geometry tests.
9. Preferences markup mixes native controls and HTML. Preserve `data-pref-tab`, `data-pref-panel`, field IDs, inline event hooks and current tab deep-link keys (`models/customization/agent/mineru/usage`). Existing roving-tabindex, Arrow/Home/End and Enter/Space support already exists in `preferenceScript.ts`.

## Functional preservation checklist

- Paper, Library and Note chat; new/empty state; item/PDF identity; Independent/Stacked layout; native details return; reader tab re-entry.
- Chat/API, original agent, Codex, Claude Code and WebChat controls, chosen model/reasoning, input-budget gauge, quotas and permission mode.
- New conversation, local history/search/rename/delete/undo/recently deleted, remote sync, local restore, pop-out, clear, export/copy/save-as-note.
- Selected text, figures/screenshots, current/multiple PDF pages, library references/collections, file upload/paste/drop, preview expansion and removal; upload progress/cancel/error/retry.
- Editable input, IME/keyboard shortcuts, slash/action/skill menus, queued follow-up, send/stop, retry/edit/fork/delete turn, draft retention during item switches.
- Streaming Markdown, code, citations/source navigation, document quotes, generated images, charts/KaTeX/Mermaid, response actions.
- Task progress, plan/review and permission cards, no-output/interrupted/error recovery, background runs and latest-message/reading-anchor behavior.
- Standalone history/search/skills/preferences navigation, sidebar resize/collapse/flyout, native titlebar controls, long/empty history.
- All existing preferences fields, provider profiles, runtime setup, PDF/MinerU/context, agent permissions/skills, usage and diagnostics.
- Chinese/English labels, accessible names/focus return/keyboard menus, dark theme, reduced motion, host font scaling and narrow-panel overflow.

## Credible execution and preview path

At audit time Node v24.22.1 and npm 11.9.0 are available; project `node_modules` and a `zotero` executable are absent. No dependency installation or native Zotero execution was attempted by this agent.

Native prerequisites are documented in `.env.example`: `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`, an isolated `ZOTERO_PLUGIN_PROFILE_PATH`, and `ZOTERO_PLUGIN_DATA_DIR`. Run native tests with a development profile/data copy rather than a user's default library. Live agent/webchat suites require credentials and may make real model/network calls.

```bash
npm ci
npm run typecheck
npm run test:unit
npm run build
npm start
npm run test:workflow
```

Targeted non-native design coverage, after installing dependencies:

```bash
npx tsx node_modules/mocha/bin/mocha.js --require ./test/register.cjs \
  test/readingSidebarDesign.test.ts \
  test/readingSidebarDesignInventory.test.ts \
  test/paperSidebarPolishCss.test.ts \
  test/runtimeSystemLayoutCss.test.ts \
  test/standaloneWindowLayoutCss.test.ts \
  test/standaloneSidebarView.test.ts \
  test/sidebarLayout.test.ts \
  test/sidebarModeSwitch.test.ts
```

`test/readingSidebarDesign.test.ts` already demonstrates a useful real-component preview seam: extract the actual top-level functions from `buildUI.ts` with TypeScript AST, transpile them, and execute with only Zotero scope/runtime dependencies stubbed. Its real builder runs against a fake DOM for tests. A browser harness can execute the same compiled builder against the actual browser DOM and load the real shared stylesheet and bundled icon paths. Import the actual pure `runtimeSystemControls`, `sidebarModeSwitch`, `standaloneSidebarView`, and taskProgress view modules where feasible. Record every stub. This gives credible production-component geometry and keyboard evidence; it does not prove Zotero native pane integration.

The previous `ui-preview/before.html`, `after.html`, `preview.css` and `render_proxy.py` hand-author alternate HTML or draw rectangles with PIL. They must not be presented as production screenshots or used as the four rounds' runtime evidence.

Relevant existing native workflows: `dedicatedChatPane.workflow.test.ts`, `sidebarChatModeToggle.workflow.test.ts`, `sidebarPointerReentry.workflow.test.ts`, `standaloneResponsiveChrome.workflow.test.ts`, `selectedItemContext.workflow.test.ts`, `historyActivity.workflow.test.ts`, `chatLatestButtonPanel.workflow.test.ts`, `chatNativeWheel.workflow.test.ts`, `chatReadingAnchor.workflow.test.ts`, `backgroundSendSwitch.workflow.test.ts`, `deletionLifecycle.workflow.test.ts`, and standalone document workflows. Native workflow imports must not pull the rich chat renderer through `hostSurfaces.ts`; `panelSurfaces.ts` explains the existing `.md` bundler restriction.

## Suggested nonoverlapping implementation ownership

| Agent | Exclusive files | Scope |
| --- | --- | --- |
| 1 | `addon/content/zoteroPane.css` | Consolidated tokens and production chat/standalone styling; container-width responsiveness |
| 2 | `src/modules/contextPanel/buildUI.ts`, `standaloneSidebarView.ts` | Real chat/standalone composition, semantic labels and light presentation metadata; preserve handler contracts |
| 3 | `addon/content/preferences.xhtml`, `src/modules/preferenceScript.ts`, explicitly named targeted design tests | Preference layout and focus/keyboard checks, independent cross-review and regression evidence |
| Lead | `docs/design-review/`, new source-backed preview harness, A/B artifact outputs, integration | Freeze shared direction first, baseline tests, four reproducible comparison rounds and final verification |

Do not assign multiple agents the giant shared stylesheet. Preference-local rules belong in the existing preferences stylesheet block, unless Agent 1 explicitly incorporates a named shared selector. Leave `chat.ts`, `setupHandlers.ts`, lifecycle/persistence and runtime engines outside this visual work unless a demonstrated regression requires a coordinated fix.

For each A/B round, keep the same fixture, dimensions, mode, theme, font scale, scroll position and state. Capture narrow reader + wide standalone at minimum; add Preferences, expanded history, context-heavy, sending/error and dark cases across rounds. The source-backed harness should log overflow, control bounding boxes, IDs, focus and interactive state. Reviewers should identify a concrete defect and retain/revert the change against evidence, not merely assert that B looks cleaner.

## Follow-up execution evidence

After the lead installed dependencies, `tsc --noEmit -p tsconfig.workflow.json` passed. The targeted eight-file non-native design group above ran with `node --import tsx` (the `tsx` CLI itself is unable to create its IPC pipe in this host). Result: 69 passing, 3 baseline failures in `readingSidebarDesignInventory.test.ts`: RGB shadow in the previous redesign suffix, 1px header border in that suffix, and `buildUI.ts:432` middot separator. All three existed before current work.

At the lead's request, added the separate `test-ui-redesign/uiRedesign.workflow.test.ts` native suite. It uses actual production conversation seed/render, intercepted pending-send, `setStatus(error)` and privileged `captureStandaloneScreenshot()` with twelve images and geometry/diagnostics manifest. Output is `${Zotero.DataDirectory.dir}/ui-redesign/capture/`; preference `extensions.zotero.llmforzotero.uiRedesignRound` controls a sanitized output folder. Run with `LLM_FOR_ZOTERO_TEST_ENTRIES=test-ui-redesign npm run test:workflow`. The error state is deliberately a fixture rendered through production code; the pending state enters the actual test-intercepted send flow. No real LLM credential or provider request is required. Native execution is owned by the lead.
