/** Compress runtime spacing, then wrap the actions if the row still cannot fit. */
export function updateHeaderSpacing(header: HTMLElement | null): void {
  if (!header || !header.getBoundingClientRect().width) return;
  const runtime = header.querySelector<HTMLElement>(
    ".llm-header-runtime-controls",
  );
  const actions = header.querySelector<HTMLElement>(".llm-header-actions");
  if (!runtime || !actions) return;

  // Measure the original spacing on every pass so widening restores it fully.
  header.classList.remove("llm-header-nav-wrapped");
  header.style.setProperty("--llm-runtime-compression", "0");
  const buttons = (
    Array.from(
      runtime.querySelectorAll(".llm-runtime-system-toggle"),
    ) as HTMLElement[]
  ).filter((button) => button.getBoundingClientRect().width > 0);
  const gap =
    parseFloat(
      header.ownerDocument.defaultView?.getComputedStyle(header)?.columnGap ||
        "0",
    ) || 0;
  const shortage =
    runtime.getBoundingClientRect().right +
    gap -
    actions.getBoundingClientRect().left;
  // Each button can give up 6px; the group and chip gaps contribute 2px and 4px.
  const available = buttons.length
    ? buttons.length * 6 + (buttons.length - 1) * 2 + 4
    : 0;
  header.style.setProperty(
    "--llm-runtime-compression",
    String(available ? Math.min(1, Math.max(0, shortage / available)) : 0),
  );
  header.classList.toggle(
    "llm-header-nav-wrapped",
    runtime.getBoundingClientRect().right + gap >
      actions.getBoundingClientRect().left + 0.5,
  );
}
