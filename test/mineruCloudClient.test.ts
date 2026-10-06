import { assert } from "chai";
import { zipSync } from "fflate";
import {
  describeMineruCurlExitForTests,
  MineruCancelledError,
  MineruRateLimitError,
  parsePdfWithMineruCloud,
  setMineruCloudTimingForTests,
} from "../src/utils/mineruClient";

const encoder = new TextEncoder();
const CDN_ZIP =
  "https://cdn-mineru.openxlab.org.cn/pdf/2026-10-04/abc/full.zip?Expires=1&Signature=secret-sig";
const OSS_ZIP =
  "https://mineru.oss-cn-shanghai.aliyuncs.com/pdf/2026-10-04/abc/full.zip?Expires=1&Signature=secret-sig";
const OTHER_ZIP = "https://results.example.org/abc/full.zip?token=secret-sig";

type HttpReply = { status: number; body?: unknown };
type Transport = "fetch" | "zotero-http";

function zip(): Uint8Array {
  return zipSync({
    "full.md": encoder.encode("# Title\n\nCloud body."),
    "content_list.json": encoder.encode("[]"),
  });
}

function done(url = OTHER_ZIP): HttpReply {
  return {
    status: 200,
    body: {
      code: 0,
      data: { extract_result: [{ state: "done", full_zip_url: url }] },
    },
  };
}

function state(value: string): HttpReply {
  return {
    status: 200,
    body: { code: 0, data: { extract_result: [{ state: value }] } },
  };
}

function code(value: number | string, msg = "Service busy"): HttpReply {
  return { status: 200, body: { code: value, msg } };
}

describe("MinerU cloud polling and result download", function () {
  const original: Record<string, unknown> = {};
  let clock: number;
  let sleeps: number[];
  let polls: Array<HttpReply | (() => never)>;
  let pollCount: number;
  let batchReply: HttpReply;
  let downloads: Array<{ transport: Transport; url: string }>;
  let download: (url: string, transport: Transport) => Uint8Array | number;
  let messages: string[];

  beforeEach(function () {
    for (const key of ["ztoolkit", "Zotero", "IOUtils"])
      original[key] = (globalThis as any)[key];
    clock = 0;
    sleeps = [];
    polls = [];
    pollCount = 0;
    messages = [];
    downloads = [];
    batchReply = {
      status: 200,
      body: {
        code: 0,
        data: { batch_id: "batch", file_urls: ["fixture://storage/upload"] },
      },
    };
    download = () => zip();
    setMineruCloudTimingForTests({
      now: () => clock,
      pollSleepMs: (ms) => {
        sleeps.push(ms);
        return 0;
      },
      zipRetryDelaysMs: [1, 1],
    });
    (globalThis as any).IOUtils = {
      read: async () => encoder.encode("%PDF-1.7"),
    };
    (globalThis as any).ztoolkit = {
      log: () => {},
      getGlobal: (key: string) =>
        key === "fetch"
          ? async (url: string, init: RequestInit = {}) => {
              if (init.method === "PUT")
                return new Response(null, { status: 200 });
              downloads.push({ transport: "fetch", url });
              const result = download(url, "fetch");
              return typeof result === "number"
                ? new Response("error", { status: result })
                : new Response(result as BodyInit, {
                    headers: { "content-type": "application/zip" },
                  });
            }
          : (globalThis as any)[key],
    };
    (globalThis as any).Zotero = {
      Prefs: { get: () => undefined },
      HTTP: {
        request: async (method: string, url: string) => {
          if (method === "POST") return reply(batchReply);
          if (url.startsWith("https://mineru.net/api/v4/extract-results/")) {
            clock += 60_000;
            const next = polls[Math.min(pollCount++, polls.length - 1)];
            return reply(typeof next === "function" ? next() : next);
          }
          downloads.push({ transport: "zotero-http", url });
          const result = download(url, "zotero-http");
          if (typeof result === "number")
            return { status: result, response: null, responseText: "" };
          return {
            status: 200,
            response: result.buffer,
            getResponseHeader: () => "application/zip",
          };
        },
      },
    };
  });

  afterEach(function () {
    setMineruCloudTimingForTests(null);
    for (const key of Object.keys(original))
      (globalThis as any)[key] = original[key];
  });

  function reply(value: HttpReply) {
    return {
      status: value.status,
      responseText: JSON.stringify(value.body ?? {}),
    };
  }

  const parse = (signal?: AbortSignal) =>
    parsePdfWithMineruCloud(
      "/tmp/paper.pdf",
      "cloud-key",
      "pipeline",
      (stage) => messages.push(stage),
      signal,
    );

  async function rejectsWith(action: Promise<unknown>, type: Function) {
    try {
      await action;
      assert.fail("Expected rejection");
    } catch (error) {
      assert.instanceOf(error, type);
      return error as Error;
    }
  }

  describe("status polling", function () {
    it("backs off and keeps polling after a status HTTP 429", async function () {
      polls = [{ status: 429 }, done()];
      assert.isNotNull(await parse());
      assert.equal(pollCount, 2);
      assert.isAtLeast(sleeps[1], 2 * sleeps[0]);
    });

    it("caps repeated status rate-limit backoff", async function () {
      polls = [...Array(8).fill({ status: 429 }), done()];
      assert.isNotNull(await parse());
      assert.equal(Math.max(...sleeps), 60_000, "the cap is reached");
      assert.isAtLeast(sleeps.filter((ms) => ms === 60_000).length, 2);
      for (let i = 2; i < 9; i++) assert.isAtLeast(sleeps[i], sleeps[i - 1]);
    });

    it("resets the rate-limit delay after a non-429 response", async function () {
      polls = [{ status: 429 }, { status: 429 }, { status: 500 }, done()];
      assert.isNotNull(await parse());
      assert.equal(pollCount, 4);
      assert.isAtLeast(sleeps[2], 4 * sleeps[0]);
      assert.equal(sleeps[3], sleeps[0], "back to the normal poll interval");
    });

    it("pauses the queue on a status HTTP 429 carrying code -60018", async function () {
      polls = [
        { status: 429, body: { code: -60018, msg: "daily limit reached" } },
        done(),
      ];
      const error = await rejectsWith(parse(), MineruRateLimitError);
      assert.include(error.message, "-60018");
      assert.equal(pollCount, 1);
    });

    it("stops promptly when paused while a status request hangs", async function () {
      const request = (globalThis as any).Zotero.HTTP.request;
      (globalThis as any).Zotero.HTTP.request = (
        method: string,
        url: string,
        ...rest: unknown[]
      ) =>
        url.startsWith("https://mineru.net/api/v4/extract-results/")
          ? new Promise(() => {})
          : request(method, url, ...rest);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const started = Date.now();
      await rejectsWith(parse(controller.signal), MineruCancelledError);
      assert.isBelow(Date.now() - started, 2000);
    });

    it("still treats batch creation HTTP 429 as the daily quota", async function () {
      batchReply = { status: 429, body: { msg: "quota" } };
      await rejectsWith(parse(), MineruRateLimitError);
    });

    for (const transient of [-10001, -60007, -60009, -60022, 12345, "B9999"])
      it(`retries status code ${transient} and then completes`, async function () {
        polls = [code(transient), done()];
        assert.isNotNull(await parse());
        assert.isTrue(
          messages.some((m) => m.includes(`(${transient})`)),
          messages.join("\n"),
        );
      });

    it("pauses the queue on the daily parsing limit (-60018)", async function () {
      polls = [code(-60018, "daily limit reached")];
      const error = await rejectsWith(parse(), MineruRateLimitError);
      assert.include(error.message, "-60018");
    });

    for (const terminal of ["A0202", "A0211", -60012, -60013])
      it(`fails immediately on status code ${terminal}`, async function () {
        polls = [code(terminal, "Token expired"), done()];
        assert.isNull(await parse());
        assert.equal(pollCount, 1);
        assert.include(messages.at(-1), `(${terminal})`);
      });

    for (const status of [401, 403])
      it(`fails immediately on status HTTP ${status}`, async function () {
        polls = [{ status }, done()];
        assert.isNull(await parse());
        assert.equal(pollCount, 1);
        assert.include(messages.at(-1), `HTTP ${status}`);
      });

    for (const status of [404, 500, 502])
      it(`retries status HTTP ${status} and then completes`, async function () {
        polls = [{ status }, done()];
        assert.isNotNull(await parse());
      });

    it("retries a thrown status request and then completes", async function () {
      polls = [
        () => {
          throw new Error("HTTP request timed out");
        },
        done(),
      ];
      assert.isNotNull(await parse());
    });

    it("keeps polling through an unrecognised state", async function () {
      polls = [state("queueing"), done()];
      assert.isNotNull(await parse());
      assert.isTrue(messages.some((m) => m.includes("queueing")));
    });

    it("does not count an unrecognised state as status", async function () {
      // Recognised once, then unrecognised: the no-status window (10 min) must
      // end the job before the 30-minute pre-processing window.
      polls = [state("pending"), state("mystery")];
      assert.isNull(await parse());
      assert.equal(messages.at(-1), "Timed out waiting for MinerU status");
      assert.isBelow(clock, 30 * 60_000);
    });

    it("ends a persistent transient status error in the timeout message", async function () {
      polls = [code(-10001)];
      assert.isNull(await parse());
      assert.equal(messages.at(-1), "Timed out waiting for MinerU status");
    });
  });

  describe("result download", function () {
    const failAll = () => {
      throw new TypeError("fetch failed");
    };

    it("falls back from the expired CDN host to the upload bucket", async function () {
      polls = [done(CDN_ZIP)];
      download = (url) =>
        url.startsWith(OSS_ZIP.split("/pdf")[0]) ? zip() : failAll();
      assert.isNotNull(await parse());
      assert.deepEqual(
        downloads.map((d) => d.url),
        [CDN_ZIP, CDN_ZIP, OSS_ZIP],
      );
    });

    it("maps an http:// CDN URL to the https upload bucket", async function () {
      const insecure = CDN_ZIP.replace("https://", "http://");
      polls = [done(insecure)];
      download = (url) => (url === OSS_ZIP ? zip() : failAll());
      assert.isNotNull(await parse());
      assert.equal(downloads.at(-1)!.url, OSS_ZIP);
    });

    for (const [label, url] of [
      ["an explicit port", CDN_ZIP.replace(".cn/", ".cn:8443/")],
      ["credentials", CDN_ZIP.replace("https://", "https://user:pass@")],
    ])
      it(`does not rewrite a CDN URL with ${label}`, async function () {
        polls = [done(url)];
        download = () => failAll();
        assert.isNull(await parse());
        assert.isNotEmpty(downloads);
        assert.isTrue(
          downloads.every((d) => d.url === url),
          downloads.map((d) => d.url).join("\n"),
        );
      });

    it("falls back when the CDN host returns bytes that are not a ZIP", async function () {
      polls = [done(CDN_ZIP)];
      download = (url) =>
        url === CDN_ZIP ? encoder.encode("<html>error</html>") : zip();
      assert.isNotNull(await parse());
      assert.equal(downloads.at(-1)!.url, OSS_ZIP);
    });

    it("never rewrites another host and lists every failed attempt", async function () {
      polls = [done(OTHER_ZIP)];
      download = (_url, transport) => (transport === "fetch" ? failAll() : 503);
      assert.isNull(await parse());
      assert.isTrue(downloads.every((d) => d.url === OTHER_ZIP));
      assert.lengthOf(downloads, 6, "two transports per try, three tries");
      const last = messages.at(-1)!;
      assert.include(last, "Failed to download ZIP result after 3 tries");
      assert.include(last, "results.example.org");
      assert.include(last, "fetch: fetch failed");
      assert.include(last, "zotero-http: HTTP 503");
      assert.include(last, "curl:");
      assert.notInclude(last, "?");
      assert.notInclude(last, "secret");
    });

    it("lists both hosts when the CDN fallback also fails", async function () {
      polls = [done(CDN_ZIP)];
      download = () => {
        throw new TypeError("fetch failed", {
          cause: { code: "CERT_HAS_EXPIRED" },
        });
      };
      assert.isNull(await parse());
      const last = messages.at(-1)!;
      assert.include(last, "cdn-mineru.openxlab.org.cn");
      assert.include(last, "mineru.oss-cn-shanghai.aliyuncs.com");
      assert.include(last, "CERT_HAS_EXPIRED");
      assert.notInclude(last, "secret");
    });

    it("retries the whole download chain after every transport fails", async function () {
      polls = [done(OTHER_ZIP)];
      let fetches = 0;
      download = (_url, transport) =>
        transport === "fetch" && ++fetches === 2 ? zip() : failAll();
      assert.isNotNull(await parse());
      assert.equal(fetches, 2);
    });

    it("stops the retry wait when the job is paused", async function () {
      setMineruCloudTimingForTests({
        now: () => clock,
        pollSleepMs: () => 0,
        zipRetryDelaysMs: [60_000, 60_000],
      });
      polls = [done(OTHER_ZIP)];
      const controller = new AbortController();
      download = (_url, transport) => {
        if (transport === "zotero-http")
          setTimeout(() => controller.abort(), 20);
        return failAll();
      };
      const started = Date.now();
      await rejectsWith(parse(controller.signal), MineruCancelledError);
      assert.isBelow(Date.now() - started, 2000);
    });

    it("explains common curl exit codes", function () {
      assert.equal(
        describeMineruCurlExitForTests(60),
        "exit 60 certificate problem",
      );
      assert.equal(
        describeMineruCurlExitForTests(35),
        "exit 35 TLS handshake failed",
      );
      assert.equal(describeMineruCurlExitForTests(28), "exit 28 timed out");
      assert.equal(
        describeMineruCurlExitForTests(6),
        "exit 6 could not resolve host",
      );
      assert.equal(
        describeMineruCurlExitForTests(7),
        "exit 7 could not connect",
      );
      assert.equal(describeMineruCurlExitForTests(22), "exit 22 HTTP error");
      assert.equal(describeMineruCurlExitForTests(99), "exit 99");
    });
  });
});
