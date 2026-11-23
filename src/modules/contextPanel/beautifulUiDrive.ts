// Beautiful UI's Drive variant from LoadingState.tsx. See its MIT license in
// addon/content/vendor/beautiful-ui/.
export function createBeautifulUiDrive(doc: Document): HTMLSpanElement {
  const grid = doc.createElement("span");
  grid.className = "llm-bui-drive";
  grid.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 9; index += 1) {
    const pixel = doc.createElement("span");
    pixel.className = "llm-bui-drive-pixel";
    grid.appendChild(pixel);
  }
  return grid;
}
