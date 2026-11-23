import { createElement } from "../../utils/domHelpers";

// Beautiful UI's Drive variant from LoadingState.tsx. See its MIT license in
// addon/content/vendor/beautiful-ui/.
export function createBeautifulUiDrive(doc: Document): HTMLSpanElement {
  const grid = createElement(doc, "span", "llm-bui-drive");
  grid.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 9; index += 1) {
    const row = Math.floor(index / 3);
    const column = index % 3;
    const delay = (column + Math.abs(row - 1)) * 90;
    const pixel = createElement(doc, "span");
    pixel.style.setProperty("--llm-bui-pixel-delay", `${delay}ms`);
    grid.appendChild(pixel);
  }
  return grid;
}
