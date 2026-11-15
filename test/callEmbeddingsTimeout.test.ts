import { assert } from "chai";
import { callEmbeddings } from "../src/utils/llmClient";
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_BATCH_TIMEOUT_MS,
  EMBEDDING_REQUEST_TIMEOUT_MS,
} from "../src/services/retrieval/constants";
import { embedTexts } from "../src/services/paperContent/pdfContext";

const PREFIX = "extensions.zotero.llmforzotero";

type FetchFake = (url: string, init?: RequestInit) => Promise<unknown>;

describe("callEmbeddings timeout", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;
  let fetchInits: Array<RequestInit | undefined>;

  /**
   * A custom embedding endpoint (no API key needed) served by `fetch`,
   * mirroring the Zotero prefs and ztoolkit fetch fakes in
   * test/llmClient.prepareChatRequest.test.ts.
   */
  function installEmbeddingFakes(options: {
    fetch: FetchFake;
    abortController?: unknown;
  }) {
    const prefStore = new Map<string, unknown>([
      [`${PREFIX}.embeddingProvider`, "custom"],
      [`${PREFIX}.embeddingApiBase`, "http://localhost:11434/v1"],
      [`${PREFIX}.embeddingModel`, "test-embed"],
    ]);
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    const fetchFake: FetchFake = (url, init) => {
      fetchInits.push(init);
      return options.fetch(url, init);
    };
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) =>
        name === "fetch"
          ? fetchFake
          : name === "AbortController"
            ? options.abortController
            : undefined,
      log: () => undefined,
    };
  }

  beforeEach(function () {
    fetchInits = [];
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
      originalToolkit;
  });

  it("rejects with a timeout error when the provider never answers", async function () {
    installEmbeddingFakes({ fetch: () => new Promise(() => undefined) });
    let error: unknown;
    try {
      await callEmbeddings(["x"], { timeoutMs: 20 });
    } catch (e) {
      error = e;
    }
    assert.match(String(error), /timed out after 20 ms/);
  });

  it("aborts the pending request when the timeout fires", async function () {
    installEmbeddingFakes({ fetch: () => new Promise(() => undefined) });
    try {
      await callEmbeddings(["x"], { timeoutMs: 20 });
    } catch {
      // expected timeout
    }
    const signal = fetchInits[0]?.signal;
    assert.isOk(signal, "the request carries an abort signal");
    assert.isTrue(signal?.aborted);
  });

  it("aborts through the controller the Zotero globals provide", async function () {
    const scope = globalThis as { AbortController?: typeof AbortController };
    const originalController = scope.AbortController;
    let aborts = 0;
    class FakeAbortController {
      readonly signal = { aborted: false } as AbortSignal;
      abort() {
        aborts += 1;
        (this.signal as { aborted: boolean }).aborted = true;
      }
    }
    // Chrome scope may have no global AbortController; apiHelpers then
    // resolves it through ztoolkit.getGlobal, like fetch.
    scope.AbortController = undefined;
    try {
      installEmbeddingFakes({
        fetch: () => new Promise(() => undefined),
        abortController: FakeAbortController,
      });
      let error: unknown;
      try {
        await callEmbeddings(["x"], { timeoutMs: 20 });
      } catch (e) {
        error = e;
      }
      assert.match(String(error), /timed out after 20 ms/);
      assert.equal(aborts, 1, "the timed-out request is aborted");
      assert.isTrue(fetchInits[0]?.signal?.aborted);
    } finally {
      scope.AbortController = originalController;
    }
  });

  it("keeps the single-argument call answering normally", async function () {
    installEmbeddingFakes({
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: [{ index: 0, embedding: [0.5, 0.25] }] }),
        text: async () => "",
      }),
    });
    assert.deepEqual(await callEmbeddings(["x"]), [[0.5, 0.25]]);
  });

  it("defaults to a thirty-second request timeout", function () {
    assert.equal(EMBEDDING_REQUEST_TIMEOUT_MS, 30_000);
  });

  it("gives per-paper chunk batches the longer batch timeout", async function () {
    const calls: Array<{ size: number; timeoutMs?: number }> = [];
    const texts = Array.from(
      { length: EMBEDDING_BATCH_SIZE + 1 },
      (_, index) => `chunk ${index}`,
    );
    const vectors = await embedTexts(texts, async (batch, options) => {
      calls.push({ size: batch.length, timeoutMs: options?.timeoutMs });
      return batch.map(() => [1]);
    });
    assert.lengthOf(vectors, texts.length);
    assert.deepEqual(calls, [
      { size: EMBEDDING_BATCH_SIZE, timeoutMs: EMBEDDING_BATCH_TIMEOUT_MS },
      { size: 1, timeoutMs: EMBEDDING_BATCH_TIMEOUT_MS },
    ]);
    assert.equal(EMBEDDING_BATCH_TIMEOUT_MS, 120_000);
  });
});
