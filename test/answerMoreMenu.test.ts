import { attachFloatingMenuInteractionController } from "../src/modules/contextPanel/setupHandlers/controllers/floatingMenuInteractionController";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { positionFloatingMenu, setFloatingMenuOpen } from "../src/modules/contextPanel/setupHandlers/controllers/menuController";
import { readFileSync } from "node:fs";
import { assert } from "chai";
import { FakeElement } from "./helpers/fakeDom";
import { attachAnswerMoreMenu, closeAnswerMoreMenu } from "../src/modules/contextPanel/answerMoreMenu";

function fixture(anchorTop: number) {
  const events = new EventTarget();
  let focused: FakeElement | undefined;
  let mutation: () => void = () => {};
  let nextTask = 0;
  const tasks = new Map<number, () => void>();
  const win = Object.assign(new EventTarget(), {innerWidth: 800, innerHeight: 600,
    setTimeout: (callback: () => void) => { const id = ++nextTask; tasks.set(id, callback); return id; },
    clearTimeout: (id: number) => { tasks.delete(id); },
    MutationObserver: class {constructor(cb: () => void) {mutation = cb;} observe() {} disconnect() {}},
  });
  const doc = {defaultView: win, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events)};
  class Node extends FakeElement {
    get ownerDocument() { return doc; }
    get childElementCount() { return this.children.length; }
    get isConnected(): boolean { return this === owner || !!this.parentElement?.isConnected; }
    focus() { focused = this; }
    closest(s: string): FakeElement | null {
      if (s === "button") return this.tagName === "button" ? this : this.parentElement?.closest(s) || null;
      return super.closest(s);
    }
    contains(node: unknown): boolean {return this === node || this.children.some(c => (c as Node).contains(node));}
    querySelector(s: string): any {
      if (s === "button:not(:disabled)") return this.findAllByTag("button").find(b => !b.disabled) || null;
      if (s === "#llm-input") return this.findAllByTag("textarea").find(b => b.id === "llm-input") || null;
      return super.querySelector(s);
    }
    getBoundingClientRect() {
      const top = this === summary ? anchorTop : 0;
      const height = this === owner ? 400 : this === summary ? 32 : 180;
      return {top, bottom:top+height, left:0, right:300, width:300, height};
    }
  }
  const owner = new Node("div"), scroller = new Node("div"), more = new Node("details"), summary = new Node("summary"), menu = new Node("div"), action = new Node("button");
  menu.append(action); more.append(summary,menu); scroller.append(more); owner.append(scroller);
  attachAnswerMoreMenu(owner as any,more as any,summary as any,menu as any);
  const open = () => {more.open=true; more.dispatchFakeEvent("toggle");};
  return {owner,scroller,more,summary,menu,action,open,Node,focused:()=>focused,events,mutation:()=>mutation(),
    pending:()=>tasks.size, flushTask:()=>{const entries=[...tasks];tasks.clear();for(const [,fn] of entries) fn();}};
}

describe("answer More floating placement and ownership", () => {
  it("escapes the clipped scroller, flips within available bounds, and returns focus on Escape", () => {
    for (const top of [8, 350]) {
      const h = fixture(top); h.open();
      assert.strictEqual(h.menu.parentElement,h.owner);
      assert.equal(h.menu.style.position,"fixed");
      assert.equal(h.menu.style.overflowY,"auto");
      assert.equal(h.menu.style.maxHeight,"384px");
      const placed = parseFloat(String(h.menu.style.top));
      assert.isAtLeast(placed,8); assert.isAtMost(placed+180,392);
      if (top === 8) assert.isAbove(placed,top+32); else assert.isBelow(placed,top);
      assert.strictEqual(h.focused(),h.action);
      const event = h.menu.dispatchFakeEvent("keydown",{key:"Escape"});
      assert.isTrue(event.propagationStopped); assert.isFalse(h.more.open);
      assert.strictEqual(h.menu.parentElement,h.more); assert.strictEqual(h.focused(),h.summary);
    }
  });
  it("closes on outside gesture, scroll, removed anchor and owning rendering disposal", () => {
    const h=fixture(8);
    h.open(); h.events.dispatchEvent(new Event("pointerdown")); assert.isFalse(h.more.open);
    h.open(); h.events.dispatchEvent(new Event("scroll")); assert.isFalse(h.more.open);
    h.open(); h.more.remove(); h.mutation(); assert.isFalse(h.more.open);
    h.scroller.append(h.more); h.open(); closeAnswerMoreMenu(h.owner as any);
    assert.isFalse(h.more.open); assert.strictEqual(h.menu.parentElement,h.more);
  });
  it("survives listener microtask checkpoints, then closes next task without taking retry focus", async () => {
    for (const hasEnabledOption of [true, false]) {
      const h = fixture(8); h.open();
      h.menu.dispatchFakeEvent("click", {target: h.action});
      assert.equal(h.pending(),1);
      await Promise.resolve(); // Browser may checkpoint after the capture listener.
      assert.isTrue(h.more.open);
      assert.strictEqual(h.menu.parentElement,h.owner);
      const retryMenu = new h.Node("div"), disabled = new h.Node("button"), option = new h.Node("button");
      disabled.disabled = true; option.disabled = !hasEnabledOption;
      retryMenu.append(disabled,option); h.owner.append(retryMenu);
      // Execute the actual production opener, not a copied fake retry handler.
      const source = readFileSync("src/modules/contextPanel/setupHandlers.ts", "utf8");
      const start = source.indexOf("  const openRetryModelMenu =");
      const end = source.indexOf("\n  };",start)+5;
      const compiled = ts.transpileModule(source.slice(start,end).replace("const openRetryModelMenu", "export const openRetryModelMenu"),
        {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
      const exports = {} as {openRetryModelMenu: (anchor: any)=>void};
      const noop = () => {};
      let positioned = false;
      runInNewContext(compiled,{exports,item:{},body:h.owner,retryModelMenu:retryMenu,retryMenuAnchor:null,
        closeSlashMenu:noop,closeResponseMenu:noop,closeExportMenu:noop,closePromptMenu:noop,
        closeHistoryNewMenu:noop,closeHistoryMenu:noop,closeModelMenu:noop,closeReasoningMenu:noop,
        rebuildRetryModelMenu:noop,closeRetryModelMenu:noop,RETRY_MODEL_MENU_OPEN_CLASS:"llm-model-menu-open",
        setFloatingMenuOpen,positionFloatingMenu:(...args: Parameters<typeof positionFloatingMenu>)=>{
          assert.isTrue(h.more.open,"delegated opener measures a visible anchor");
          positioned=true; positionFloatingMenu(...args);
        }});
      exports.openRetryModelMenu(h.action);
      assert.isTrue(positioned);
      const focusTarget = hasEnabledOption ? option : retryMenu;
      assert.strictEqual(h.focused(),focusTarget);
      await Promise.resolve();
      assert.isTrue(h.more.open,"even a later listener checkpoint cannot close it");
      h.flushTask();
      assert.isFalse(h.more.open);
      assert.strictEqual(h.focused(),focusTarget,"dismiss does not restore summary or leave focus on hidden action");
    }
  });
  it("cancels pending close on dismissal/disposal so it cannot close a reopened menu", () => {
    for (const dismiss of [false,true]) {
      const h=fixture(8); h.open(); h.menu.dispatchFakeEvent("click",{target:h.action});
      assert.equal(h.pending(),1);
      if (dismiss) h.menu.dispatchFakeEvent("keydown",{key:"Escape"});
      else closeAnswerMoreMenu(h.owner as any); // disposeChatRendering uses this owner cleanup.
      assert.equal(h.pending(),0);
      h.open(); h.flushTask(); assert.isTrue(h.more.open);
      closeAnswerMoreMenu(h.owner as any);
    }
  });
  it("captures Escape by the actual retry-menu event target and restores a visible entry, never hidden Retry", () => {
    for (const detached of [false,true]) {
      const h=fixture(8); h.more.className="llm-answer-more"; h.open();
      h.menu.dispatchFakeEvent("click",{target:h.action}); h.flushTask();
      const retryMenu=new h.Node("div"), option=new h.Node("button"), input=new h.Node("textarea");
      input.id="llm-input"; retryMenu.append(option); h.owner.append(retryMenu,input);
      setFloatingMenuOpen(retryMenu as any,"llm-model-menu-open",true);
      option.focus();
      if (detached) h.more.remove();
      Object.assign(h.action,{getClientRects:()=>[]}); // hidden inside closed More
      Object.assign(h.summary,{getClientRects:()=>detached ? [] : [h.summary.getBoundingClientRect()]});
      Object.assign(input,{getClientRects:()=>[input.getBoundingClientRect()]});
      const doc=h.owner.ownerDocument;
      const captures:boolean[]=[];
      const add=doc.addEventListener;
      Object.assign(doc,{querySelectorAll:()=>[],activeElement:input,
        addEventListener:(type:string,listener:any,capture?:boolean)=>{if(type==="keydown") captures.push(capture===true);add(type,listener,capture);}});
      Object.assign(doc.defaultView,{getComputedStyle:()=>({visibility:"visible"})});
      let anchor:FakeElement|null=h.action, closes=0;
      const close=()=>{closes++;setFloatingMenuOpen(retryMenu as any,"llm-model-menu-open",false);anchor=null;};
      attachFloatingMenuInteractionController({body:h.owner,panelDoc:doc,retryModelMenu:retryMenu,
        getRetryMenuAnchor:()=>anchor,closeRetryModelMenu:close,
        getPaperChipMenu:()=>null,getPaperChipMenuSticky:()=>false,
      } as any);
      assert.include(captures,true,"handler must run during document capture, before Reader bubbling");
      const key=(target:FakeElement,key:string)=>{
        const event=new Event("keydown",{bubbles:true,cancelable:true});
        Object.defineProperties(event,{target:{value:target},key:{value:key}});
        let stopped=false;
        event.stopPropagation=()=>{stopped=true;Event.prototype.stopPropagation.call(event);};
        h.events.dispatchEvent(event);
        return {event,stopped};
      };
      const arrow=key(option,"ArrowDown");
      assert.isFalse(arrow.event.defaultPrevented); assert.isFalse(arrow.stopped);
      const elsewhere=key(input,"Escape");
      assert.isFalse(elsewhere.event.defaultPrevented);assert.equal(closes,0);
      const escape=key(option,"Escape"); // event.target is authoritative, not activeElement.
      assert.isTrue(escape.event.defaultPrevented);assert.isTrue(escape.stopped);
      assert.equal(closes,1);assert.equal(retryMenu.style.display,"none");
      assert.strictEqual(h.focused(),detached ? input : h.summary);
      assert.notStrictEqual(h.focused(),h.action);
      const closed=key(option,"Escape");
      assert.isFalse(closed.event.defaultPrevented);assert.equal(closes,1);
      // The existing outside-pointer close remains independent of keyboard focus restoration.
      setFloatingMenuOpen(retryMenu as any,"llm-model-menu-open",true);
      h.events.dispatchEvent(new Event("pointerdown"));
      assert.equal(closes,2);assert.equal(retryMenu.style.display,"none");
    }
  });

});
