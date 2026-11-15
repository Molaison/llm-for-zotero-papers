import { assert } from "chai";
import { describe, it } from "mocha";
import { createReferenceSelectorPanelLayout } from "../src/modules/contextPanel/referenceSelector/panelLayout";

class FakeStyle {
  height = "";
  private properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) || "";
  }
}

class FakeClassList {
  private tokens = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.tokens.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.tokens.delete(token);
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

class FakeWindow {
  private readonly eventListeners = new Map<
    string,
    Array<(event: Event) => void>
  >();

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.eventListeners.get(type) || [];
    listeners.push((event: Event) => {
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    });
    this.eventListeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.eventListeners.get(type) || [];
    this.eventListeners.set(
      type,
      listeners.filter((registered) => registered !== listener),
    );
  }

  dispatch(type: string, event: Partial<MouseEvent> = {}): void {
    const mouseEvent = {
      type,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...event,
    } as unknown as Event;
    for (const listener of this.eventListeners.get(type) || []) {
      listener(mouseEvent);
    }
  }
}

class FakeDocument {
  readonly defaultView = new FakeWindow();

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

class FakeElement {
  className = "";
  readonly classList = new FakeClassList();
  readonly style = new FakeStyle();
  readonly children: FakeElement[] = [];
  private rectHeight = 0;
  private readonly eventListeners = new Map<
    string,
    Array<(event: Event) => void>
  >();

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(): void {
    // Attribute values are not inspected in these layout tests.
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.eventListeners.get(type) || [];
    listeners.push((event: Event) => {
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    });
    this.eventListeners.set(type, listeners);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.eventListeners.get(event.type) || []) {
      listener(event);
    }
    return true;
  }

  setBoundingClientRect(height: number): void {
    this.rectHeight = height;
  }

  getBoundingClientRect(): DOMRect {
    return { height: this.rectHeight } as DOMRect;
  }
}

function makePanelLayout(maxHeight: string) {
  const style = new FakeStyle();
  style.setProperty("--llm-paper-picker-max-height", maxHeight);
  let renderCount = 0;
  const layout = createReferenceSelectorPanelLayout({
    paperPicker: { style } as unknown as HTMLDivElement,
    paperPickerList: null,
    getMode: () => "browse",
    render: () => {
      renderCount += 1;
    },
  });
  return {
    layout,
    style,
    getRenderCount: () => renderCount,
  };
}

function makeRenderedPanelLayout(maxHeight: string) {
  const ownerDoc = new FakeDocument();
  const paperPicker = ownerDoc.createElementNS("", "div");
  const paperPickerList = ownerDoc.createElementNS("", "div");
  const shell = ownerDoc.createElementNS("", "div");
  const folders = ownerDoc.createElementNS("", "div");
  const references = ownerDoc.createElementNS("", "div");
  const tags = ownerDoc.createElementNS("", "div");

  paperPicker.style.setProperty("--llm-paper-picker-max-height", maxHeight);
  folders.setBoundingClientRect(220);
  references.setBoundingClientRect(150);
  tags.setBoundingClientRect(28);
  shell.appendChild(folders);
  shell.appendChild(references);
  shell.appendChild(tags);
  paperPickerList.appendChild(shell);

  const layout = createReferenceSelectorPanelLayout({
    paperPicker: paperPicker as unknown as HTMLDivElement,
    paperPickerList: paperPickerList as unknown as HTMLDivElement,
    getMode: () => "browse",
    render: () => undefined,
  });

  return {
    ownerDoc,
    layout,
    folders,
    references,
  };
}

describe("reference selector panel layout", function () {
  it("keeps folders and items open by default when the available height is constrained", function () {
    const { layout } = makePanelLayout("400px");

    layout.fitPanelsToAvailableHeight();

    assert.isFalse(layout.isCollapsed("folders"));
    assert.isFalse(layout.isCollapsed("references"));
    assert.isTrue(layout.isCollapsed("tags"));
  });

  it("auto-collapses another open panel when expanding would exceed the available height", function () {
    const { layout, getRenderCount } = makePanelLayout("400px");

    assert.isFalse(layout.isCollapsed("folders"));
    assert.isFalse(layout.isCollapsed("references"));
    assert.isTrue(layout.isCollapsed("tags"));

    layout.toggleCollapsed("tags");

    assert.isFalse(layout.isCollapsed("folders"));
    assert.isTrue(layout.isCollapsed("references"));
    assert.isFalse(layout.isCollapsed("tags"));
    assert.equal(getRenderCount(), 1);
  });

  it("leaves all panels open when the available height can fit them", function () {
    const { layout } = makePanelLayout("720px");

    layout.toggleCollapsed("tags");

    assert.isFalse(layout.isCollapsed("folders"));
    assert.isFalse(layout.isCollapsed("references"));
    assert.isFalse(layout.isCollapsed("tags"));
  });

  it("auto-collapses on an existing open stack after the available height shrinks", function () {
    const { layout, style } = makePanelLayout("720px");
    layout.toggleCollapsed("tags");

    style.setProperty("--llm-paper-picker-max-height", "400px");
    layout.fitPanelsToAvailableHeight();

    assert.isFalse(layout.isCollapsed("folders"));
    assert.isTrue(layout.isCollapsed("references"));
    assert.isFalse(layout.isCollapsed("tags"));
  });

  it("resizes items by borrowing height from the folder panel above it", function () {
    const { ownerDoc, layout, folders, references } =
      makeRenderedPanelLayout("400px");
    const separator = layout.createPanelSeparator(
      ownerDoc as unknown as Document,
      "references",
      references as unknown as HTMLElement,
    );

    separator.dispatchEvent({
      type: "mousedown",
      button: 0,
      clientY: 200,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    } as unknown as Event);
    ownerDoc.defaultView.dispatch("mousemove", { clientY: 100 });

    assert.equal(references.style.height, "205px");
    assert.equal(folders.style.height, "165px");
  });
});
