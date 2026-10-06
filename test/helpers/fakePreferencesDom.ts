/**
 * A stand-in for the preferences window's chrome document.
 *
 * `test/helpers/fakeDom.ts` answers the chat panel's needs; the Usage tab asks
 * for a different, smaller set — namespaced element creation, attribute
 * selectors, `isConnected`, layout rectangles and real mouse events — and it
 * asks for them through a `Document` the render code believes in. This is that
 * document. Nothing here models CSS: a rectangle is whatever the test says it
 * is, which is the only honest thing a headless fake can claim about layout.
 */

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";

export type FakeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

export type FakeMouseEvent = {
  type: string;
  clientX: number;
  clientY: number;
  target: FakePrefElement;
};

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/** One compound selector: `tag`, `#id`, `[attr]`, `[attr="value"]`, joined. */
type Matcher = {
  tag?: string;
  id?: string;
  attributes: Array<{ name: string; value?: string }>;
};

function parseSelector(selector: string): Matcher {
  const matcher: Matcher = { attributes: [] };
  let rest = selector.trim();
  const attributePattern = /\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  rest = rest.replace(
    attributePattern,
    (_all, name: string, value?: string) => {
      matcher.attributes.push({ name, value });
      return "";
    },
  );
  const idMatch = /#([\w-]+)/.exec(rest);
  if (idMatch) {
    matcher.id = idMatch[1];
    rest = rest.replace(idMatch[0], "");
  }
  const tag = rest.trim();
  if (tag) matcher.tag = tag.toLowerCase();
  return matcher;
}

export class FakePrefElement {
  public readonly children: FakePrefElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly style: Record<string, string> = {};
  public parentElement: FakePrefElement | null = null;
  public className = "";
  public type = "";
  public title = "";
  /** Form-control state a binder writes and a test reads, as on a real input. */
  public checked = false;
  public disabled = false;
  public value = "";
  /** What `getBoundingClientRect` reports; a test sets it where it matters. */
  public rect: FakeRect = rect(0, 0, 0, 0);
  private ownText = "";
  private readonly listeners = new Map<
    string,
    Array<(event: FakeMouseEvent) => void>
  >();

  constructor(
    public readonly tagName: string,
    public readonly namespaceURI: string = HTML_NS,
    private readonly owner?: FakePrefDocument,
  ) {}

  get isConnected(): boolean {
    if (!this.parentElement) return Boolean(this.owner?.isRoot(this));
    return this.parentElement.isConnected;
  }

  get firstChild(): FakePrefElement | null {
    return this.children[0] || null;
  }

  /** The element's own text, excluding its descendants'. */
  get text(): string {
    return this.ownText;
  }

  get textContent(): string {
    return [this.ownText, ...this.children.map((c) => c.textContent)].join("");
  }

  set textContent(value: string) {
    for (const child of [...this.children]) this.removeChild(child);
    this.ownText = value ?? "";
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    // A real element's inline style IS its style object; render code that
    // writes `style="display: none"` and then reads `style.display` must see
    // the same value here or a test would be asserting against the fake.
    if (name === "style") {
      for (const declaration of String(value).split(";")) {
        const [property, ...rest] = declaration.split(":");
        const key = (property || "").trim();
        if (!key || !rest.length) continue;
        this.style[
          key.replace(/-([a-z])/g, (_all, letter: string) =>
            letter.toUpperCase(),
          )
        ] = rest.join(":").trim();
      }
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakePrefElement): FakePrefElement {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  removeChild(child: FakePrefElement): FakePrefElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  addEventListener(
    type: string,
    listener: (event: FakeMouseEvent) => void,
  ): void {
    const existing = this.listeners.get(type) || [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(
    type: string,
    listener: (event: FakeMouseEvent) => void,
  ): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((fn) => fn !== listener),
    );
  }

  /** Fire one listener set directly; the panel never relies on bubbling. */
  dispatch(
    type: string,
    init: { clientX?: number; clientY?: number } = {},
  ): void {
    const event: FakeMouseEvent = {
      type,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      target: this,
    };
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener(event);
    }
  }

  click(): void {
    this.dispatch("click");
  }

  matches(selector: string): boolean {
    const matcher = parseSelector(selector);
    if (matcher.tag && matcher.tag !== this.tagName.toLowerCase()) return false;
    if (matcher.id && matcher.id !== this.getAttribute("id")) return false;
    for (const attribute of matcher.attributes) {
      const value = this.getAttribute(attribute.name);
      if (value === null) return false;
      if (attribute.value !== undefined && value !== attribute.value) {
        return false;
      }
    }
    return true;
  }

  querySelectorAll(selector: string): FakePrefElement[] {
    const found: FakePrefElement[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  querySelector(selector: string): FakePrefElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  /** Every element in this subtree, this one included, in document order. */
  descendants(): FakePrefElement[] {
    return [
      this as FakePrefElement,
      ...this.children.flatMap((child) => child.descendants()),
    ];
  }
}

export class FakePrefDocument {
  public readonly body = new FakePrefElement("body", HTML_NS, this);
  public defaultView: FakePrefWindow | null = null;

  createElementNS(namespace: string, tag: string): FakePrefElement {
    return new FakePrefElement(tag, namespace, this);
  }

  createElement(tag: string): FakePrefElement {
    return new FakePrefElement(tag, HTML_NS, this);
  }

  querySelector(selector: string): FakePrefElement | null {
    return this.body.matches(selector)
      ? this.body
      : this.body.querySelector(selector);
  }

  querySelectorAll(selector: string): FakePrefElement[] {
    return this.body.querySelectorAll(selector);
  }

  isRoot(element: FakePrefElement): boolean {
    return element === this.body;
  }
}

export type FakePrefWindow = {
  document: FakePrefDocument;
  navigator: { language: string };
  matchMedia: (query: string) => {
    matches: boolean;
    media: string;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
  };
};

export type FakePreferencesWindow = {
  win: FakePrefWindow;
  doc: FakePrefDocument;
  /** `#<addonRef>-usage-root`, the element the panel renders into. */
  root: FakePrefElement;
  /** The tab-bar button the panel listens to. */
  tabButton: FakePrefElement;
  /** Change the colour scheme the panel sees, as the real media query would. */
  setDarkMode: (dark: boolean) => void;
};

/**
 * A document holding just the two nodes the Usage panel looks for: its render
 * root and the tab button that activates it.
 */
export function createFakePreferencesWindow(options: {
  addonRef: string;
  rootRect?: FakeRect;
  locale?: string;
  dark?: boolean;
}): FakePreferencesWindow {
  const doc = new FakePrefDocument();
  let dark = Boolean(options.dark);
  const schemeListeners: Array<() => void> = [];
  const win: FakePrefWindow = {
    document: doc,
    navigator: { language: options.locale || "en-US" },
    matchMedia: (query: string) => ({
      matches: query.includes("dark") ? dark : !dark,
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        schemeListeners.push(listener);
      },
      removeEventListener: () => undefined,
    }),
  };
  doc.defaultView = win;
  const tabButton = doc.createElement("button");
  tabButton.setAttribute("data-pref-tab", "usage");
  doc.body.appendChild(tabButton);
  const root = doc.createElement("div");
  root.setAttribute("id", `${options.addonRef}-usage-root`);
  root.rect = options.rootRect || rect(0, 0, 0, 0);
  doc.body.appendChild(root);
  return {
    win,
    doc,
    root,
    tabButton,
    setDarkMode: (next: boolean) => {
      dark = next;
      for (const listener of schemeListeners) listener();
    },
  };
}

export { rect as fakeRect };

/** Every element in the subtree that carries text of its own. */
export function collectOwnText(root: FakePrefElement): string[] {
  return root
    .descendants()
    .map((element) => element.text)
    .filter((text) => text.trim().length > 0);
}

/** Resolve after every already-queued microtask and timer callback. */
export async function flushAsync(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
