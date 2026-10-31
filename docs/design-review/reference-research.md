# Reference research — ChatGPT-led research assistant

Research date: 2026-10-28. Research only; no production UI changed. No repository `AGENTS.md` found. Applied `claude-design-workflow` and its personal UI defaults. Product observations below are based on official screenshots/animations actually opened and visually inspected, not inferred from product marketing text. Dated references are design evidence, not claims about every current client.

## 1. Three products inspected

| Product and exact evidence | What was actually visible | Research-user benefit and transfer |
| --- | --- | --- |
| **ChatGPT macOS companion window**, official release notes, 2024-08-06: https://help.openai.com/en/articles/9703738-chatgpt-macos-app-release-notes ; image: https://images.ctfassets.net/j22is2dtoxu1/intercom-img-374990b487f74b1ee99c00e1/866332b9f2450a841283fce85cd07e43/Companion_window_8_6.png | A narrow floating chat beside Mail; soft gray user bubble aligned right, largely unboxed assistant prose, bottom composer, attachment control and circular send control. The conversation occupies almost the entire window. | Strongest reference for the Zotero sidebar: the user keeps the paper visible and reads a focused answer without a dashboard. Transfer the quiet canvas, asymmetric message treatment, compact composer, and one dominant send action. |
| **NotebookLM three-panel redesign**, official Google announcement, 2024-12-13: https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-new-features-december-2024/ ; actual animation: https://storage.googleapis.com/gweb-uniblog-publish-prod/original_images/3_panel_ui_keyword_final_7_sources.gif | Inspected frames 0, 90, 250, 400 and 550 of the 566-frame, 1440×1024 GIF. Sources list uses checkboxes, Chat has ordinary prose and a bottom composer with source count, Studio lists notes and generation actions. Later frames expand a source, expand a note editor, and collapse Sources to an icon rail while widening Chat. | Useful IA: explicit input scope → conversation → durable outputs. Transfer a visible source/context count and a way to inspect included material, plus response-level “Save note”. Transfer the **adaptation**, not three permanent columns. |
| **Zotero PDF reader and note editor**, official documentation: https://www.zotero.org/support/pdf_reader ; image: https://www.zotero.org/static/images/blog/6.0/pdf-reader.jpg | Three zones: annotation list left, paper center, note editor right. Annotation entries display page number and excerpt; an image selection is visible in the PDF and the note. A citation popup offers Show Item / Edit Citation / Hide Citation. | Grounding is a first-class research task. Transfer concise page/figure citations adjacent to the answer and preserve a direct route back to source context; retain Save note. Do not replace this with generic “sources used” badges that cannot be opened. |
| **Zotero 7 library and reference popup**, official launch: https://www.zotero.org/blog/zotero-7/ ; library image: https://www.zotero.org/static/images/blog/7.0/library.png ; popup image: https://www.zotero.org/static/images/blog/7.0/reference-popup.png | Library has dense row-oriented information and a right metadata pane. The reader reference popup sits near the citation, keeping the paper beneath visible. Official explanation says the item header persists when metadata is collapsed. | A short persistent paper title is valuable even when context details are hidden. Research users need a stable “which paper am I discussing?” anchor. Use rows, disclosure and local popovers before extra cards. |

## 2. Second pass: disputes checked against evidence

### Does “NotebookLM-like” require three columns?

No. The official animation itself collapses the Sources column to a thin rail and changes pane widths. The announcement explicitly describes expanding the source viewer and note editor as needed. At 360–440px, a permanent sources or history column would consume the conversation's reading width. Recommendation: a single chat canvas in the Zotero pane, history as a drawer/popover, context details behind one compact disclosure row. A separate wide window may keep history visible when sufficient width exists.

Current official mobile instructions also place the source selector in the prompt box and refer to separate Chat and Studio panels: https://support.google.com/gemininotebook/answer/16296687 (How to use, steps 4–5). This corroborates progressive disclosure rather than forcing desktop columns into a narrow surface. It does not prove the current mobile layout is identical to the 2024 desktop animation.

### Should model and provider controls occupy the header?

ChatGPT's official macOS notes (2024-11-14) explicitly show a model picker in the chat bar: https://help.openai.com/en/articles/9703738-chatgpt-macos-app-release-notes . Official web notes (2024-11-22) describe floating history, a fixed composer, and removing the system icon to recover horizontal space: https://help.openai.com/en/articles/6825453-chatgpt-release-notes . These are dated examples, and different clients differ. Our inference: put provider/model selection near the composer where it changes the next request; reserve the header for scope and navigation. Keep existing Chat/WebChat/Codex/Claude behavior intact, but avoid a second visually competing row of navigation-sized controls.

### Can context disappear entirely for a quieter chat?

No. NotebookLM's source count remains near the composer in the inspected animation. Official chat help verifies source selection and clicking citations to navigate to the exact passage: https://support.google.com/gemininotebook/answer/16179559 . Zotero documentation verifies that note annotations carry PDF-page links and citations. Recommendation: retain paper identity plus a compact context summary; hide detailed controls, not the fact that sources are attached.

## 3. Executable unified direction

1. Header: quiet Paper / Library scope switch, compact new-chat/history controls, optional overflow. Scope and backend must remain visually distinct concepts.
2. Paper identity: one restrained title row, ellipsis for long titles, secondary author/year only when useful. No standalone framed “paper card”.
3. Transcript: assistant answers on the canvas; user messages in a soft neutral bubble. Avoid avatars, timestamps and repeated assistant names unless they help distinguish actors. Long scientific text, math and tables must retain width and selection behavior.
4. Evidence: small clickable page/figure controls near the relevant answer; response actions use understated text/icon controls. Progress is one line with expandable detail, not a permanent status card after completion.
5. Composer: one clear rounded input surface, contextual material immediately above/inside it, one black send/stop action. Add context/selection/screenshot live in a concise tools menu or a compact contextual row. Model/provider selector remains discoverable without competing with send.
6. Palette and rhythm: semantic Radix gray surfaces and text, black primary action, status color only where meaningful; ordinary separators 0.5px; no decorative shadow except true overlays; approximately three type sizes (12px utility, 13–14px controls, 14–15px reading text), with hierarchy from weight and spacing.

## 4. Do not copy

- ChatGPT's generic large empty-state hero and unlimited spacious gutters: they waste Zotero's narrow reading area. Use compact research-specific suggestions and realistic long titles.
- NotebookLM's purple accent, large generation tiles and full Studio panel: these would become a second app inside Zotero and distract from the requested ChatGPT direction.
- Zotero's dense toolbar and document-centric three-zone layout: Zotero already supplies the paper and annotation environment. The assistant should complement it.
- A mock backend label or invented Ready/Complete state: preserve the actual state machine. Loading, stop, retry, failed source extraction and unavailable provider must remain truthful and keyboard reachable.

## Evidence handling and limits

The four official visual assets were retrieved as temporary inspection materials in `/tmp/reference-research/`; screenshots were actually viewed. No browser was initialized for research. Search results were verified with primary official pages; the Google GIF was extracted locally because web retrieval reported unsupported image/gif. Current official help uses the name “Gemini Notebook”, while the inspected 2024 design is explicitly NotebookLM. These notes deliberately distinguish the two dates and do not claim the historical screenshot is today's exact UI.
