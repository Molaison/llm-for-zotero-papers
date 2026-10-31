import { parseFragment } from "parse5";
import { FakeElement } from "./fakeDom";

/** Parse actual production Markdown HTML for identity tests; geometry remains native-only. */
export class MarkdownNode extends FakeElement {
  nodeValue: string | null = null;
  get nodeType() { return this.tagName === "#text" ? 3 : 1; }
  get nodeName() { return this.nodeType === 3 ? "#text" : this.tagName.toUpperCase(); }
  get isConnected() { return true; }
  setAttribute(name: string, value: string) {
    super.setAttribute(name, value);
    if (name === "class") {
      this.classList.remove(...this.className.split(/\s+/));
      this.classList.add(...value.split(/\s+/));
    }
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  replaceChild(fresh: FakeElement, old: FakeElement) {
    this.insertBefore(fresh, old); this.removeChild(old); return old;
  }
  get innerHTML(): string {
    return this.children.map(child => {
      const node = child as MarkdownNode;
      if (node.nodeType === 3) return node.nodeValue || "";
      const attrs = Object.entries(node.attributes).map(([key,value]) => ` ${key}="${value}"`).join("");
      return `<${node.tagName}${attrs}>${node.innerHTML}</${node.tagName}>`;
    }).join("");
  }
  set innerHTML(html: string) {
    const convert = (parsed: any): MarkdownNode => {
      const node = new MarkdownNode(parsed.tagName || "#text");
      node.nodeValue = parsed.value ?? null;
      for (const {name,value} of parsed.attrs || []) node.setAttribute(name,value);
      for (const child of parsed.childNodes || []) node.append(convert(child));
      return node;
    };
    this.replaceChildren(...parseFragment(html).childNodes.map(convert));
  }
}
