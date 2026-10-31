# Round 2 reference review

Compared actual A=round-1 and B=round-2 images 02/07/13, plus B's newly captured 14 More and 15 Sources. No production edits during review.

**1. Task outcome.** B is better for recovering from an interrupted evidence check. Error 07 now displays the whole connection message beneath the input and a visible “Retry…” button beside the response. At 380px (13), the paper identity, question, response, recovery action and composer remain readable. This follows the ChatGPT reference's local, contextual actions; the status no longer depends on a tooltip.

**2. Resolved and remaining.** Wide 02 has one New/History navigation set when the rail is expanded. The collapsed Paper chip now shows a chevron, helping users discover the existing scope switch. Source 15 opens upward without clipping, with an identifiable source chip rather than another title card. Two adjacent plus signs remain in every composer: the dynamic controller still replaces the new Add label. History screenshot 03 should not be treated as proof of visible navigation after the rail action changed.

**3. Newly exposed defects.** More 14 has a blank row where Delete belongs, and offers “Open chat in a standalone window” while already standalone. The blank row is not evidence of lost handlers, but it prevents users from naming the action. No prior 14 exists in A, so this is a newly observed defect, not a demonstrated R2-only regression. In the current on-disk B02 image opened at original detail, the model label “gpt-4o-mini” is visible; B07 and embedded13 also show it. Its reported disappearance is not reproduced by these files.

**4. Keep / revise.** Keep the full-width wrapping status, truthful Retry… label, scope chevron and conditional navigation. Keep the current typography and source placement. Revise the Add controller and More labels before acceptance; do not hide More to conceal its blank action.

**5. Next priority and cause.** `actionLayoutController.ts:54` overwrites Add with “+”. `setupHandlers.ts:6887` clears Delete's text after buildUI gave it a label. The source-menu CSS appropriately hides button icons, making the cleared text appear blank. More's `display:flex` selector also outranks the standalone Popout `display:none` selector. Repair those three ownership conflicts, then recheck actual Add/More/Retry and the real Search history action.
