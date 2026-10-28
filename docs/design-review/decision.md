# Research workspace redesign

Baseline: `51c574544d860b670fb34000717c78f829e81f6e`, 2026-10-28.

## Direction

The active task is reading a paper, asking a grounded question and following up without losing the paper. Use the quiet ChatGPT companion pattern inside Zotero, and retain research-specific source controls, citations and note actions.

One consistent hierarchy: **Paper / Library scope → identifiable paper or library → conversation → context and composer**. History is navigation; provider/runtime is a request setting; source selection is the content of the next request. These must not look like competing destinations. Wide standalone windows retain the existing collapsible history sidebar; narrow views devote their width to the conversation.

## Shared contract

- Existing IDs, conversation identity, persistence, handler ownership, source toggles, remote sync/restore, note/export, stop/retry and runtime behavior remain intact.
- Visible scope labels use Paper / Library and 论文 / 文献库; internal conversation enums and stored titles remain unchanged.
- Assistant prose sits on the canvas; user prompts use a neutral surface. One primary send/stop control. No redundant framed header/scope/transcript cards.
- Keep actual Radix slate/indigo/status scales and map semantic roles: surfaces 1–3, selected 4–5, separators 6, input boundaries 7–8, secondary/primary text 11–12. Primary send uses slate12 and slate1; indigo remains for links/focus where appropriate. Dark roles resolve independently in the existing host theme.
- Use the existing host-scaled 12/14/16 type tokens, 4/8/12/16/24 spacing, 0.5px separators, 2px functional focus outline. No decorative shadows/motion. Composer radius 20px, user bubble 16px, compact controls 8px; overlays have their own boundary.
- English source strings pass through `t()`; new Chinese entries have one owner. Status is visible when actionable, including errors, pending work and stop; idle metadata stays quiet.
- Narrow acceptance: 380px actual window, long title/model, no clipped send or horizontal page overflow. Wide acceptance: 1000×760, readable transcript width and persistent source identity. Include dark mode and expanded/history states.

## Ownership

| Agent | Files | Acceptance |
| --- | --- | --- |
| Reference/design | `addon/content/zoteroPane.css` | coherent tokens/layout, no competing cards, source/header visible in initial standalone, narrow and dark controls usable |
| Product/IA | `buildUI.ts`, `sidebarChatModeToggle.ts`, `standaloneSidebarView.ts`, `standaloneWindow.ts`, `standaloneTabLabel.ts`, `sidebarModeSwitch.ts` | consistent navigation, clear groups, context next to input, preserve stable handler IDs and all operations |
| Code/states | `chat.ts`, `src/utils/i18n.ts`, `test-ui-redesign/*` | accurate absent-paper/ready/library states, actionable recovery, native deterministic capture suite |
| Root | integration, evidence snapshots, focused checks, later explicitly assigned controller changes | compare real A/B, reject regressions, produce branch and runnable XPI |

Do not edit another owner's file. Send required shared strings/selectors to its owner. Each round takes the previous accepted version as A and the new render as B; evidence determines retention, not a score.

## Validation boundary

Native captures use an isolated Zotero profile and deterministic local paper/conversation fixtures. Pending sends are intercepted before a provider request. They prove the production UI is rendered in Gecko and the tested interactions work; they do not prove a paid model response or remote relay. Previous hand-drawn `ui-preview`/PIL images are not used as evidence.
