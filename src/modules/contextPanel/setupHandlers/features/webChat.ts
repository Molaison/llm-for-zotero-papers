import type { SetupHandlersContext } from "../types";

/**
 * Everything the WebChat feature needs from the panel closure that it cannot
 * read off the {@link SetupHandlersContext}. Deps are thunks so the feature can
 * be constructed before the panel helpers they reach are assigned.
 */
export type WebChatFeatureDeps = {
  /** True when the selected model entry runs through the WebChat relay. */
  isWebChatMode: () => boolean;
  /** True when this paper already has a live WebChat session to return to. */
  hasExistingWebChatSession: () => boolean;
  /** Model name used to resolve the relay's active target site. */
  getCurrentModelName: () => string | null | undefined;
  /**
   * Ask the relay whether the browser extension is alive. Defaults to the live
   * relay client, which is what the panel always uses. It is injectable so a
   * test can drive the poll without importing the relay module into a process
   * that has no Zotero global — that import fails and stays failed for every
   * later importer.
   */
  probeRelayConnection?: () => Promise<boolean>;
};

/** Abort token for an in-flight preload — Gecko has no `AbortController`. */
export type WebChatPreloadToken = { aborted: boolean };

/**
 * The WebChat panel feature: it owns the two resources that outlive a detached
 * panel body — the connection-dot poll and the preload abort token — so that
 * `unmount()` is the single place that releases them.
 */
export type WebChatFeature = {
  /**
   * Cold-start work: show the preload screen when the panel opens straight
   * into WebChat mode without an existing session. Adds no listeners and
   * starts no timer; the connection poll begins only when the mode chip
   * actually shows its dot.
   */
  mount: (ctx: SetupHandlersContext) => void;
  /** Release the poll and any in-flight preload. Idempotent. */
  unmount: () => void;
  /**
   * Point the relay at the target site for the current model before the panel
   * applies its WebChat UI, so the extension sidebar filters correctly.
   */
  primeColdStartTarget: () => void;
  /**
   * Begin polling the relay and paint the result onto the mode controls'
   * dots: the Independent tab's and the Stacked chip's share one poll.
   */
  startConnectionCheck: (...dots: Array<HTMLElement | null>) => void;
  /** Stop the poll if one is running. */
  stopConnectionCheck: () => void;
  /** Abort any in-flight preload and take a fresh token for a new one. */
  beginPreload: () => WebChatPreloadToken;
  /** Forget the current token without aborting it (preload finished). */
  clearPreload: () => void;
  /** Abort any in-flight preload. */
  abortPreload: () => void;
};

export function createWebChatFeature(deps: WebChatFeatureDeps): WebChatFeature {
  const { isWebChatMode, hasExistingWebChatSession, getCurrentModelName } =
    deps;
  const probeRelayConnection =
    deps.probeRelayConnection ||
    (async () => {
      // Always use dynamic port — saved apiBase may be stale
      const { getRelayBaseUrl } =
        await import("../../../../webchat/relayServer");
      const host = getRelayBaseUrl();
      const { testConnection } = await import("../../../../webchat/client");
      return testConnection(host);
    });
  let connectionTimer: ReturnType<typeof setInterval> | null = null;
  // Simple abort token — Zotero's Gecko context lacks AbortController.
  let preloadAbort: WebChatPreloadToken | null = null;

  const abortPreload = () => {
    if (preloadAbort) {
      preloadAbort.aborted = true;
      preloadAbort = null;
    }
  };

  const beginPreload = (): WebChatPreloadToken => {
    abortPreload();
    const token = { aborted: false };
    preloadAbort = token;
    return token;
  };

  const clearPreload = () => {
    preloadAbort = null;
  };

  const startConnectionCheck = (...dots: Array<HTMLElement | null>) => {
    stopConnectionCheck();
    const paint = (className: string) => {
      for (const dot of dots) if (dot) dot.className = className;
    };
    const check = async () => {
      try {
        const alive = await probeRelayConnection();
        paint(
          alive
            ? "llm-webchat-dot llm-webchat-dot-connected"
            : "llm-webchat-dot llm-webchat-dot-disconnected",
        );
      } catch {
        paint("llm-webchat-dot llm-webchat-dot-disconnected");
      }
    };
    void check(); // immediate first check
    connectionTimer = setInterval(check, 5000);
  };

  const stopConnectionCheck = () => {
    if (connectionTimer !== null) {
      clearInterval(connectionTimer);
      connectionTimer = null;
    }
  };

  const primeColdStartTarget = () => {
    try {
      if (isWebChatMode()) {
        // Synchronous require, as in the panel closure this moved from: the
        // relay target must be set before the panel applies its WebChat UI in
        // the same tick, so a dynamic import() is not interchangeable here.
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { getWebChatTargetByModelName: getColdTarget } =
          require("../../../../webchat/types") as typeof import("../../../../webchat/types");
        const { relaySetActiveTarget: setColdTarget } =
          require("../../../../webchat/relayServer") as typeof import("../../../../webchat/relayServer");
        /* eslint-enable @typescript-eslint/no-require-imports */
        const coldStartModel = getCurrentModelName();
        const coldEntry = getColdTarget(coldStartModel || "");
        if (coldEntry?.id) setColdTarget(coldEntry.id);
      }
    } catch {
      /* isWebChatMode may not be ready */
    }
  };

  const mount = (ctx: SetupHandlersContext) => {
    // [webchat] Cold startup → show preload screen so user knows they're in webchat mode
    try {
      if (isWebChatMode() && !hasExistingWebChatSession()) {
        const chatShellEl = ctx.body.querySelector(
          ".llm-chat-shell",
        ) as HTMLElement | null;
        if (chatShellEl) {
          void (async () => {
            try {
              const token = beginPreload();
              const { showWebChatPreloadScreen } =
                await import("../../../../webchat/preloadScreen");
              const { getWebChatTargetByModelName } =
                await import("../../../../webchat/types");
              const { relaySetActiveTarget: relaySetTarget2 } =
                await import("../../../../webchat/relayServer");
              const coldModel = getCurrentModelName();
              const coldTargetEntry = getWebChatTargetByModelName(
                coldModel || "",
              );
              if (coldTargetEntry?.id) relaySetTarget2(coldTargetEntry.id);
              await showWebChatPreloadScreen(
                chatShellEl,
                token,
                coldTargetEntry?.label,
                coldTargetEntry?.modelName,
              );
            } catch {
              // Preload failed or was aborted — dot will show connection status
            } finally {
              clearPreload();
            }
          })();
        }
      }
    } catch {
      // isWebChatMode may not be ready during initial render
    }
  };

  const unmount = () => {
    // The connection-check interval and preload token outlive the detached
    // body otherwise — one leaked 5s timer per abandoned WebChat panel.
    stopConnectionCheck();
    abortPreload();
  };

  return {
    mount,
    unmount,
    primeColdStartTarget,
    startConnectionCheck,
    stopConnectionCheck,
    beginPreload,
    clearPreload,
    abortPreload,
  };
}
