# Product and interaction audit

Date: 2026-10-28. Scope: the checked-out `codex/papers` implementation, its README, chat DOM builder, start pages, standalone shell, mode switch and history controllers. No production code changed for this audit. No applicable `AGENTS.md` exists in this repository or its ancestors.

## Product decision

Keep one research workspace with three persistent regions: conversation scope, reading timeline, and composer. The primary task is **ask about the active paper, read the answer and its evidence, then ask a follow-up**. Library research is the second scope of the same workspace. Backend, runtime, window arrangement and conversation history are supporting controls rather than competing product destinations.

The checked-out branch already has a previous redesign. Its scope bar and grouped conversation menu are useful foundations. `docs/ui-redesign-hill-climb.md` explicitly identifies its old round images as PIL proxies, so those images cannot establish actual browser or Zotero behavior. The next review should render the real TypeScript-built DOM and real CSS, with a documented fixture when Zotero itself is unavailable.

## Observed main paths

| Task | Existing path | Product contract to preserve |
| --- | --- | --- |
| Ask about a paper | Select Zotero item/PDF → Paper scope → enter prompt → choose model/reasoning → send | The current paper is identifiable before sending; existing paper binding and remote session behavior remain intact. |
| Compare papers | Library scope or current paper → Add context / `@` → pick references → send | Users can see and remove everything included in the next request. |
| Discuss a figure or passage | Reader selection or screenshot → context preview → send | Reader-specific tools remain available without showing inactive controls in library mode. |
| Continue work | History → find title/search → open conversation | Local vs remote records and conversation scope must be clear. |
| Use an independent window | Open in Window → shared conversation → focus window or return here | A single conversation owner remains authoritative; the placeholder must explain how to return. |
| Configure first use | Preferences → connection/backend → test connection → start chat | An unconfigured state needs an obvious next action, not only an eventual send error. |

## Findings and concrete work

### P0 — Empty paper state currently describes a paper that does not exist

- `src/modules/contextPanel/chat.ts:10455` calls `getPaperChatStartPageHtml()` when `item` is absent.
- `src/utils/i18n.ts:1572` says “Ask about this paper, or select annotations to discuss.”
- `src/modules/contextPanel/buildUI.ts:1044` simultaneously disables the textarea and says “Open a PDF first”. The scope bar and status separately ask the user to select a paper/item.
- **Change:** define an actual no-paper state with one concise sentence and one next step. Paper present, paper absent, library empty conversation, connection unconfigured and backend disconnected are distinct states. Never show “this paper” without an item. Avoid repeating the same prerequisite in scope, timeline, placeholder and footer.
- **Acceptance:** no-item screenshot contains no assertion of attached paper; available controls identify what can be done next. Starting with an ordinary paper and starting with a library portal show different, accurate context copy.

### P0 — Scope disappears at the precise moment it matters before first send

- `addon/content/zoteroPane.css:3155` hides `.llm-header` on the standalone start page.
- The current paper title, creator/year and scope live inside that header (`buildUI.ts:393`). The standalone shell has a separate title and mode tabs, but its start-state behavior needs verification against the real mounted DOM.
- **Change:** hide duplicate conversation actions in standalone, while retaining the scope identity. Use targeted selectors or move identity into a stable shared location; do not hide the whole header simply to remove duplicated controls.
- **Acceptance:** standalone new Paper chat shows the selected paper title before a prompt is typed; switching to Library does not leave stale paper identity.

### P1 — Scope vocabulary differs by layout and surface

- `buildUI.ts:267` creates top tabs named “Chat” and “Papers”. `sidebarChatModeToggle.ts:31` defines “Paper chat” / “Library chat”; the stacked mode switch uses those labels.
- `standaloneWindow.ts:942` creates “Paper chat” / “Library chat” tabs; scope copy repeats those terms. Note and WebChat replace or disable portions of this switch.
- **Change:** choose one pair for every surface. Recommended pair: **Paper / Library**, with the paper title or “Your Zotero library” directly below. Use the same short pair in side panel and standalone; explain scope once in empty states. A Paper destination is not a list of papers, so avoid “Papers” if it only changes chat scope.
- **Acceptance:** sidebar, stacked mode and standalone use the same noun for the same scope. Keyboard and touch activation have the same outcome. WebChat/note-only states explain why the alternative scope is unavailable.

### P1 — Default paper and additional request context occupy different zones

- `buildUI.ts:810` builds the current paper preview, then places it inside header `#llm-source-control` / `#llm-paper-bar`. A separate source shortcut is added beside model controls.
- `buildUI.ts:759` places selected text, screenshots, files, Add context and Agent toggle in the composer tray. The result is two places answering “what will I send?”
- The WebChat instructions in `i18n.ts` describe highlighted/unhighlighted paper chips and right-click changes, which require knowledge of hidden interaction.
- **Change:** keep a compact current-paper source chip and added-material chips adjacent to the prompt. One Add context menu exposes reader selection, figure screenshot, file upload and reference selection. Source modes should have visible labels such as “Current paper · retrieval” or “PDF attached”; advanced mode changes belong in the chip menu and must be available by keyboard. Keep the source preview itself as progressive disclosure.
- **Acceptance:** a screenshot of the composer is sufficient to identify the next request's paper/files/selected text and attachment mode. Each context has a clear remove action. A long paper title cannot reduce the Send target.

### P1 — Too many independent request concepts look equally important

- `buildUI.ts:765` exposes Agent mode, `:1139` model selection, `:1155` reasoning, `:1232` context usage and `:1195` run status. Runtime systems are in the conversation More menu.
- These represent capability, model choice, cost/limits, progress and transport. They should not read as a row of equivalent tabs.
- **Change:** use one quiet composer footer: Add context on the left; model with its current value and optional reasoning in a compact picker; Send as the sole solid control on the right. Agent is an explicit mode chip near the model. Context usage and quota remain secondary, expanding on demand. Show run status only when meaningful; use task progress for multi-step work rather than repeating all status text.
- **Acceptance:** send remains visually dominant at 360/400/520px. Model names ellipsize with a full accessible name. Reasoning hidden/unsupported state does not leave a gap or blank disabled button. Error text has enough room and an actionable recovery.

### P1 — First use lacks a clear, in-place connection handoff

- README Quick Start sends the user through provider, URL, key, model, test connection and then the reader icon. Current start pages are only one-line prompts (`i18n.ts:1572`, `:1605`).
- `buildUI.ts:1148` initially shows `Model: ...`; this is an implementation placeholder while handlers load, not a meaningful connection state.
- **Change:** resolve to loading, configured, missing configuration or disconnected states. A missing connection should show a compact “Connect a model” action that opens the existing preferences pane. Keep setup instructions out of the normal successful empty state. The next available action should remain obvious after a failed connection test.
- **Acceptance:** screenshot the first-use state with no API key and the ready state with a valid fixture. Neither contains indefinite ellipses, impossible send actions or instructions that assume setup succeeded.

### P1 — History is split across local and remote systems without enough contextual framing

- Side-panel history is a popover with a second click to expand search (`historyLifecycleController.ts:1230`). Standalone has a permanent New chat/Search history/Skills navigation (`standaloneSidebarView.ts:123`).
- WebChat switches the standalone list to fetched remote records (`standaloneWindow.ts:1450`); `catch` while waiting for the remote snapshot can leave `historyFetchFailed` false, so an unavailable relay may display “No conversations yet” (`:1490–1524`).
- CPR's separate “Sync remote conversation” replaces local records and supports a local restore point per README; it must not be conflated with browsing history.
- **Change:** preserve New chat and History as familiar, compact primary actions. When history is open, show the search field immediately. Give remote sources a discreet source label and distinguish loading, no records and failed fetch. Keep replace/restore operations in More with explicit action names and existing confirmation behavior.
- **Acceptance:** empty local history, remote loading, disconnected remote history and matching/no-match search each render accurately. “Sync” is never presented as a harmless list refresh if it replaces messages.

### P2 — Mixed-language and implementation-oriented labels weaken consistency

- `buildUI.ts:367`, `:535`, `:828`, `:1266` hard-code Chinese labels for More, quick questions, paper sources and status while surrounding labels use `t()`.
- `buildUI.ts:1079` labels the entire model group “Reasoning”, which understates its purpose. `:494` labels the whole header “Conversation history”, even though it contains scope and conversation tools.
- **Change:** localize every visible and accessible label through the existing dictionary; name groups by what they contain (“Model and reasoning”, “Conversation controls”). Retain concise, task-oriented language. Remove redundant scope-kind labels only where the remaining title and active tab make the mode unambiguous.
- **Acceptance:** English and Chinese screenshots have no accidental mixed-language controls. Screen-reader group names match visible purpose.

### P2 — Standalone navigation has a sound structure, but needs state-aware density

- `standaloneSidebarView.ts` already supplies New chat, Search history, Skills, history region and Preferences, including collapse and resize controls. Do not replace this with a second navigation system.
- `standaloneWindow.ts:387` provides a helpful ownership placeholder with Focus Window and Close Window & Return Here.
- **Change:** retain those paths. Keep history rows single-line by default with timestamp/scope secondary; reveal per-row commands on hover/focus. Separate the sidebar visually using surface tone rather than multiple card outlines. Ensure collapse has a stable, discoverable restore target, including keyboard activation; floating sidebar behavior must not be pointer-only.
- **Acceptance:** expanded, collapsed and no-history states all retain New chat and Settings access. Opening/closing the standalone window returns the same conversation and draft to the authoritative surface.

## Agreed implementation boundaries to propose

| Area | Safe focused changes | Contract to preserve |
| --- | --- | --- |
| `buildUI.ts` | Region ordering, labels, group semantics, explicit context and overflow structure | Existing IDs, data attributes and event-handler targets |
| `i18n.ts` and `chat.ts` | Accurate empty/start-state copy and minimal conditional routing | Conversation identity and send/state machines |
| `standaloneWindow.ts`, `standaloneSidebarView.ts` | Surface vocabulary, scope/title visibility, history status labels | Single window ownership, history selection and persistence |
| `zoteroPane.css` | Tokens, reading width, spacing, responsive priorities and state treatment | XUL/XHTML compatibility, focus states and all active conditional states |
| History controllers | Immediate search and accurate fetch failure only if assigned | Search indexing, delete/undo, restore and remote replacement semantics |

A broad rewrite of chat persistence, source resolution, or provider adapters is unnecessary for this design goal. Existing workflow tests target those boundaries; presentation changes should preserve them.

## Four meaningful A/B review rounds

Use actual rendered DOM/CSS with fixed fixture data and viewport sizes. Record which controls changed and the task advantage, not only that a version is “cleaner”.

1. **Scope and hierarchy:** A is current code, B is the agreed stable scope + timeline + composer layout. Compare a populated Paper conversation and a new Library conversation at 420px. Choose based on accurate scope identity, readable answer area and no duplicated navigation.
2. **Composer and first use:** carry the chosen layout forward. Compare current sources split across header/composer against unified next-request context. Include no paper, no configured connection, paper attached, selected text and long model name. Reject any variant whose Send target moves offscreen or whose context state is ambiguous.
3. **History and standalone:** compare matched populated and empty views in expanded/collapsed standalone. Include remote disconnected history. Verify scope remains visible before first send and local/remote actions cannot be mistaken for each other.
4. **Responsive and recovery:** compare 360/400/520px and desktop in light/dark mode with long paper title, large context set, streaming, stop, error and retry. Retain the version that keeps one primary action, readable recovery text and access to all necessary controls; revert ornamental changes that reduce usable reading area.

For every round report: hypothesis, same-data screenshot pair, choice, observed regression, retained/reverted change, next unresolved question. Browser fixture screenshots are honest evidence of the real DOM/CSS in that browser; they do not prove native Zotero bindings or persistence. Native workflow verification remains a separate evidence column.

## Native review — Round 1

Compared real Gecko/Zotero screenshots in `evidence/round-0` and `evidence/round-1`, including populated wide/narrow and the 380px embedded paper fixture. Retain the Round 1 direction: the paper title appears once, the assistant response has readable prose size, the user prompt is visibly distinct, sources sit next to the prompt, and Send remains visible at narrow widths.

Round 2 should address three observed tasks, not add decoration:

- The composer displays two adjacent plus signs. Keep one visible Add context entry and its existing accessible label; remove the duplicate pseudo-element/text treatment.
- Standalone still displays New/History next to its paper identity while the expanded sidebar already exposes New chat and Search history. Keep those buttons on embedded panels; hide their duplicate standalone presentation with a selector that wins the cascade, retaining IDs and event handlers.
- The collapsed stacked Paper control in the 380px embedded screenshot looks like a static label. Preserve its existing hover/focus/click navigation, but add a small disclosure indicator so Library is discoverable before a user learns its behavior.

Pending evidence: opened More and opened source menus, first-use/no-paper state, disabled Note/WebChat scope, model menu and stop/error recovery. The screenshot alone cannot establish that an unseen control or remote provider works.
