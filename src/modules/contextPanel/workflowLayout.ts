/** Native workflow synchronization for animated sidebar geometry. */
export async function waitForElementGeometrySettled(params: {
  element: Element;
  sample: () => string;
  delay: () => Promise<void>;
}): Promise<void> {
  let previous = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    const sample = params.sample();
    // Sampling can run twice between rendered frames. Equal geometry alone
    // says nothing about a still-running or not-yet-started CSS transition.
    const animating = params.element
      .getAnimations()
      .some(
        (animation) => animation.pending || animation.playState === "running",
      );
    if (!animating && sample === previous) return;
    previous = sample;
    await params.delay();
  }
  throw new Error("Native workflow element geometry did not settle");
}
