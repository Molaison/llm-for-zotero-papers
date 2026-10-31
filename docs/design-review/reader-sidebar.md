# Reader sidebar: scope and evidence

Status: native reader evidence reviewed; retain both existing layouts and the Stacked default. This addition verifies the existing sidebar; it adds no production sidebar feature.

## Primary reading surface

The core task is reading the PDF on the left while asking questions in Zotero's right reader sidebar. Opening a standalone chat window is an optional extension of this task. The reader sidebar must support the same paper identity, conversation, source controls, composer, citations and recovery actions as the shared chat UI.

Reuse Zotero's native sidenav and splitter. Keep the sidebar inside the reader's existing item-details host; let the splitter allocate space between the PDF and chat. Preserve the per-tab ownership contract so a retained background PDF cannot receive another paper's conversation or selected text.

The reader sidebar and standalone history sidebar serve different purposes:

| Surface | Purpose | Entry |
| --- | --- | --- |
| Reader's right sidebar | Ask about the PDF while keeping its pages visible | Open a PDF in Zotero. If the whole right pane is hidden, first click the pane toggle at the top right of the PDF toolbar; then click the plugin's chat icon on the visible native right sidenav |
| Standalone window's history sidebar | Navigate conversations within the separate chat window | Open standalone chat, then use its history navigation |

The standalone history sidebar does not satisfy the reader-side requirement.

## Layout preference

Keep **Stacked (default)** and the existing **Independent** full-height option. Stacked places chat alongside Zotero's other item sections; Independent gives chat its own full-height pane within the same right reader sidebar. Both retain the PDF on the left. This task does not change the default or migrate a user's saved preference.

The setting is **Zotero Preferences → llm-for-zotero → Chat experience → Sidebar layout**. Changes apply immediately. The source tab key remains `customization`; the visible tab label is `Chat experience` (`addon/content/preferences.xhtml`). The preference reader and observer are in `src/modules/contextPanel/sidebarLayout.ts`.

## Implementation boundary

`registerReaderContextPanel()` in `src/modules/contextPanel/index.ts` registers the native section and binds it during Zotero's item/render lifecycle. `panelHostOwnership.ts` tracks the reader tab, attachment and parent paper; `readerPopupPanelRouting.ts` selects the exact tab's host. Retain these paths instead of introducing a second panel mount or global active-paper shortcut.

Native fixtures should open the PDF with `Zotero.Reader.open`, locate its host with `getReaderContextPanelForTab`, and activate the actual sidenav entry. `test-workflows/nativeStreamingResponsiveness.workflow.test.ts` and `dedicatedChatPane.workflow.test.ts` already exercise this route. Test APIs that accept `surface: "embedded"` without `panelId` can target the mounted reader panel for deterministic conversation and streaming states.

## Evidence boundary

Existing 380px captures in `test-ui-redesign/uiRedesign.workflow.test.ts` show production components inside a synthetic mounted host. They are component evidence; they do not establish PDF-and-chat coexistence or the native reader entry. The new [reader manifest](evidence/reader-sidebar/manifest.json) records eight real-host, full main-window captures at 1360×900 in Zotero 10.0.6. The final native suite passed in 15.5 seconds using an isolated profile, local PDFs and a deterministic stored conversation.

The overall acceptance flow remains reading a paper, asking a question, adding selected PDF text, following a quote, and switching between papers without losing ownership or conversation state. This additional run checks native placement, Sources disclosure, rail close/reopen, PDF tab switching, draft restoration and stored history. Unsent drafts currently use a bounded in-memory cache; this scope does not promise draft recovery after application restart.

## Verification and A/B result

This is a layout A/B within the same production build, not a before/after implementation comparison. The [source record](evidence/reader-sidebar/source.json) identifies commit `24a43f91a9b661bf2a4ac25b12d88e35bc5611fc` and file hashes. Visual inspection covered captures 01, 02, 03, 07 and 08, plus the final corrected capture 06; the suite supplies the interaction assertions below.

| Comparison or check | Observation | IA decision |
| --- | --- | --- |
| [A: Stacked](evidence/reader-sidebar/01-reader-stacked-full.png) / [B: Independent](evidence/reader-sidebar/02-reader-independent-full.png), same 357px native pane | PDF stays 1003px wide in both. Chat grows from 304×730px to 320×819px; Independent removes the stacked title/section chrome and exposes more conversation vertically. | Independent suits sustained paper Q&A; retain Stacked for users who want other Zotero sections alongside chat. Keep the existing default and saved preferences. |
| [Near-380px chat](evidence/reader-sidebar/03-reader-independent-narrow-full.png) | A 414px native-pane request yields a 377px chat and 946px PDF. This chat is wider than B's initial 320px; the filename's “narrow” means the near-380px acceptance target. Composer and Send remain in the viewport; measured panel horizontal overflow is zero. | Accept the measured native geometry; do not label this an exact 380px render or a narrower A/B variant. |
| Sources and pane controls, captures 04–06 | Sources opens; Escape closes it and returns focus to the summary. Clicking the chat rail closes the right pane and expands the PDF. To restore it, click the visible PDF-toolbar pane toggle, then the visible chat rail; the draft remains intact. The manifest records these visible 28×28px entry controls. | Keep the native two-step reopening route and disclosure behavior. Do not imply that a hidden rail can be clicked. |
| [Paper B](evidence/reader-sidebar/07-reader-paper-b-full.png) → [restored A](evidence/reader-sidebar/08-reader-paper-a-restored-full.png) | B has its own empty conversation/composer and owner. A returns to owner 1 / attachment 2 with its draft and four stored history messages preserved. | Accept the demonstrated per-tab ownership and in-session restoration. |

The reader run changes test-profile layout/width and window size, opens fixture tabs and seeds history; its cleanup restores prior preferences/geometry and removes fixtures. No production code or Stacked default changed. A wider right pane consumes PDF width, as the 1003→946px measurement shows; Independent's same-width gain comes from using the available pane more fully.

This run makes no live provider request and does not record a physical splitter-drag mouse trajectory. Add Text and citation navigation have prior passing coverage in [native workflows](validation/native-workflows.txt), including selected-page preservation and passage highlighting; this addition does not supply new full-window captures of those interactions. Dark mode, live send/stop/recovery behavior and restart persistence are not newly established by these eight reader captures.
