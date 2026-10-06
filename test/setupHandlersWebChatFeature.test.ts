import { assert } from "chai";
import {
  createWebChatFeature,
  type WebChatFeature,
  type WebChatFeatureDeps,
} from "../src/modules/contextPanel/setupHandlers/features/webChat";
import type { SetupHandlersContext } from "../src/modules/contextPanel/setupHandlers/types";

type BodyProbe = {
  element: Element;
  selectors: string[];
  listeners: string[];
};

/**
 * The feature only ever reaches the panel body to look for the chat shell, so
 * a probe is enough to tell "the cold-start guard passed" from "it never got
 * that far" — and to prove the feature attaches no listeners of its own.
 */
function createBodyProbe(chatShell: HTMLElement | null = null): BodyProbe {
  const probe: BodyProbe = {
    element: null as unknown as Element,
    selectors: [],
    listeners: [],
  };
  probe.element = {
    querySelector: (selector: string) => {
      probe.selectors.push(selector);
      return chatShell;
    },
    addEventListener: (type: string) => {
      probe.listeners.push(type);
    },
    removeEventListener: (type: string) => {
      probe.listeners.push(`-${type}`);
    },
  } as unknown as Element;
  return probe;
}

function createContext(probe: BodyProbe): SetupHandlersContext {
  return { body: probe.element } as unknown as SetupHandlersContext;
}

type TimerLog = {
  started: Array<{ id: number; ms: number }>;
  cleared: number[];
};

/**
 * Runs `body` with `setInterval`/`clearInterval` replaced by recorders. The
 * poll callback still runs once immediately, exactly as it does in the panel.
 */
function withTimerLog<T>(body: (log: TimerLog) => T): T {
  const log: TimerLog = { started: [], cleared: [] };
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let nextId = 1;
  (globalThis as unknown as Record<string, unknown>).setInterval = (
    _handler: unknown,
    ms: number,
  ) => {
    const id = nextId++;
    log.started.push({ id, ms });
    return id;
  };
  (globalThis as unknown as Record<string, unknown>).clearInterval = (
    id: number,
  ) => {
    log.cleared.push(id);
  };
  try {
    return body(log);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}

function createFeature(
  overrides: Partial<WebChatFeatureDeps> = {},
): WebChatFeature {
  return createWebChatFeature({
    isWebChatMode: () => true,
    hasExistingWebChatSession: () => false,
    getCurrentModelName: () => "gpt-5",
    // Never reach the live relay from a unit test: importing it without a
    // Zotero global fails and poisons the module for every later importer.
    probeRelayConnection: async () => true,
    ...overrides,
  });
}

const dot = () => ({ className: "" }) as unknown as HTMLElement;

/** Let the poll's fire-and-forget first check finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("setupHandlers WebChat feature", function () {
  describe("mount", function () {
    it("adds no listeners and starts no poll", function () {
      const probe = createBodyProbe();
      withTimerLog((log) => {
        createFeature().mount(createContext(probe));
        assert.deepEqual(log.started, [], "mount must not start a timer");
      });
      assert.deepEqual(probe.listeners, [], "mount must not add listeners");
    });

    it("looks for the chat shell only for a WebChat panel with no session", function () {
      const outsideWebChat = createBodyProbe();
      createFeature({ isWebChatMode: () => false }).mount(
        createContext(outsideWebChat),
      );
      assert.deepEqual(outsideWebChat.selectors, []);

      const existingSession = createBodyProbe();
      createFeature({ hasExistingWebChatSession: () => true }).mount(
        createContext(existingSession),
      );
      assert.deepEqual(existingSession.selectors, []);

      const coldStart = createBodyProbe();
      createFeature().mount(createContext(coldStart));
      assert.deepEqual(coldStart.selectors, [".llm-chat-shell"]);
    });

    it("survives dependencies that are not ready yet", function () {
      const probe = createBodyProbe();
      assert.doesNotThrow(() => {
        createFeature({
          isWebChatMode: () => {
            throw new Error("model info not ready");
          },
        }).mount(createContext(probe));
      });
      assert.deepEqual(probe.selectors, []);
    });
  });

  describe("connection check", function () {
    it("polls every five seconds once the dot is shown", function () {
      withTimerLog((log) => {
        createFeature().startConnectionCheck(dot());
        assert.lengthOf(log.started, 1);
        assert.strictEqual(log.started[0].ms, 5000);
      });
    });

    it("replaces a running poll rather than stacking a second one", function () {
      withTimerLog((log) => {
        const feature = createFeature();
        feature.startConnectionCheck(dot());
        feature.startConnectionCheck(dot());
        assert.lengthOf(log.started, 2);
        assert.deepEqual(
          log.cleared,
          [log.started[0].id],
          "the first poll must be cleared before the second starts",
        );
      });
    });

    it("paints the dot green when the relay answers", async function () {
      const feature = createFeature({ probeRelayConnection: async () => true });
      const target = dot();
      feature.startConnectionCheck(target);
      feature.unmount();
      await settle();
      assert.strictEqual(
        target.className,
        "llm-webchat-dot llm-webchat-dot-connected",
      );
    });

    it("paints every dot it shows, from one poll", async function () {
      // The Independent tab and the Stacked chip each carry a dot.
      const tab = dot();
      const chip = dot();
      await withTimerLog(async (log) => {
        const feature = createFeature({
          probeRelayConnection: async () => true,
        });
        feature.startConnectionCheck(tab, chip);
        assert.lengthOf(log.started, 1, "one poll serves both dots");
        await settle();
      });
      for (const target of [tab, chip]) {
        assert.strictEqual(
          target.className,
          "llm-webchat-dot llm-webchat-dot-connected",
        );
      }
    });

    it("paints the dot grey when the relay cannot be reached", async function () {
      const feature = createFeature({
        probeRelayConnection: async () => {
          throw new Error("relay down");
        },
      });
      const target = dot();
      feature.startConnectionCheck(target);
      feature.unmount();
      await settle();
      assert.strictEqual(
        target.className,
        "llm-webchat-dot llm-webchat-dot-disconnected",
      );
    });

    it("stops a poll that is running and ignores one that is not", function () {
      withTimerLog((log) => {
        const feature = createFeature();
        feature.stopConnectionCheck();
        assert.deepEqual(log.cleared, [], "nothing to stop yet");
        feature.startConnectionCheck(dot());
        feature.stopConnectionCheck();
        feature.stopConnectionCheck();
        assert.deepEqual(log.cleared, [log.started[0].id]);
      });
    });
  });

  describe("preload token", function () {
    it("hands out a fresh token and aborts the one it replaces", function () {
      const feature = createFeature();
      const first = feature.beginPreload();
      const second = feature.beginPreload();
      assert.isTrue(first.aborted, "the replaced preload must be aborted");
      assert.isFalse(second.aborted);
      assert.notStrictEqual(first, second);
    });

    it("forgets a finished preload without aborting it", function () {
      const feature = createFeature();
      const token = feature.beginPreload();
      feature.clearPreload();
      feature.abortPreload();
      assert.isFalse(
        token.aborted,
        "a preload that already finished must not be marked aborted",
      );
    });
  });

  describe("unmount", function () {
    it("stops the connection check and aborts the preload", function () {
      withTimerLog((log) => {
        const feature = createFeature();
        feature.startConnectionCheck(dot());
        const token = feature.beginPreload();

        feature.unmount();

        assert.deepEqual(log.cleared, [log.started[0].id]);
        assert.isTrue(token.aborted);
      });
    });

    it("is idempotent", function () {
      withTimerLog((log) => {
        const feature = createFeature();
        feature.startConnectionCheck(dot());
        const token = feature.beginPreload();

        feature.unmount();
        feature.unmount();
        feature.unmount();

        assert.deepEqual(
          log.cleared,
          [log.started[0].id],
          "the poll must be cleared exactly once",
        );
        assert.isTrue(token.aborted);
        assert.deepEqual(log.started, [{ id: log.started[0].id, ms: 5000 }]);
      });
    });

    it("does nothing when the feature never mounted", function () {
      withTimerLog((log) => {
        assert.doesNotThrow(() => createFeature().unmount());
        assert.deepEqual(log.cleared, []);
      });
    });
  });

  describe("cold-start relay target", function () {
    it("stays out of the way outside WebChat mode", function () {
      let asked = false;
      assert.doesNotThrow(() =>
        createFeature({
          isWebChatMode: () => false,
          getCurrentModelName: () => {
            asked = true;
            return "gpt-5";
          },
        }).primeColdStartTarget(),
      );
      assert.isFalse(asked, "the model name must not be read outside WebChat");
    });

    it("swallows a dependency that is not ready yet", function () {
      assert.doesNotThrow(() =>
        createFeature({
          isWebChatMode: () => {
            throw new Error("model info not ready");
          },
        }).primeColdStartTarget(),
      );
    });
  });
});
