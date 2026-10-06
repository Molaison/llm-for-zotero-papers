import { assert } from "chai";
import {
  buildMineruFilenameMatcher,
  DEFAULT_MINERU_CLOUD_MODEL,
  DEFAULT_MINERU_FORCE_OCR,
  DEFAULT_MINERU_MAX_AUTO_PAGES,
  DEFAULT_MINERU_LOCAL_API_BASE,
  MAX_MINERU_FILENAME_PATTERN_LENGTH,
  normalizeMineruCloudModel,
  normalizeMineruForceOcr,
  normalizeMineruMaxAutoPages,
  normalizeMineruLocalApiBase,
  normalizeMineruLocalBackend,
  normalizeMineruMode,
  toMineruApiBackend,
} from "../src/utils/mineruConfig";

describe("mineruConfig", function () {
  it("defaults to 200 pages when no page limit is saved", function () {
    assert.equal(DEFAULT_MINERU_MAX_AUTO_PAGES, 200);
    assert.equal(normalizeMineruMaxAutoPages(undefined), 200);
  });

  it("preserves HTTP-client backends and uses the supported engine names", function () {
    assert.equal(
      normalizeMineruLocalBackend("vlm-http-client"),
      "vlm-http-client",
    );
    assert.equal(
      normalizeMineruLocalBackend("hybrid-http-client"),
      "hybrid-http-client",
    );
    assert.equal(toMineruApiBackend("vlm", "3.4.5"), "vlm-engine");
    assert.equal(toMineruApiBackend("hybrid", "3.4.5"), "hybrid-engine");
    assert.equal(toMineruApiBackend("hybrid", "3.3.0"), "hybrid-auto-engine");
  });

  describe("normalizeMineruMode", function () {
    it("accepts local and otherwise falls back to cloud", function () {
      assert.equal(normalizeMineruMode("local"), "local");
      assert.equal(normalizeMineruMode("cloud"), "cloud");
      assert.equal(normalizeMineruMode("community"), "cloud");
      assert.equal(normalizeMineruMode(undefined), "cloud");
    });
  });

  describe("normalizeMineruLocalApiBase", function () {
    it("trims and removes trailing slashes", function () {
      assert.equal(
        normalizeMineruLocalApiBase(" http://127.0.0.1:8000/ "),
        "http://127.0.0.1:8000",
      );
      assert.equal(
        normalizeMineruLocalApiBase("https://mineru.local/api///"),
        "https://mineru.local/api",
      );
      assert.equal(
        normalizeMineruLocalApiBase("https://mineru.local/api/?debug=1#top"),
        "https://mineru.local/api",
      );
    });

    it("falls back to the default for empty or unsupported URLs", function () {
      assert.equal(
        normalizeMineruLocalApiBase(""),
        DEFAULT_MINERU_LOCAL_API_BASE,
      );
      assert.equal(
        normalizeMineruLocalApiBase("file:///tmp/mineru"),
        DEFAULT_MINERU_LOCAL_API_BASE,
      );
      assert.equal(
        normalizeMineruLocalApiBase("http://"),
        DEFAULT_MINERU_LOCAL_API_BASE,
      );
    });
  });

  describe("normalizeMineruLocalBackend", function () {
    it("accepts the three valid backend codes", function () {
      assert.equal(normalizeMineruLocalBackend("pipeline"), "pipeline");
      assert.equal(normalizeMineruLocalBackend("vlm"), "vlm");
      assert.equal(normalizeMineruLocalBackend("hybrid"), "hybrid");
    });

    it("falls back to pipeline for unknown or empty values", function () {
      assert.equal(normalizeMineruLocalBackend(""), "pipeline");
      assert.equal(normalizeMineruLocalBackend(undefined), "pipeline");
      assert.equal(normalizeMineruLocalBackend("vlm-auto-engine"), "pipeline");
    });
  });

  describe("normalizeMineruCloudModel", function () {
    it("accepts the valid cloud model codes", function () {
      assert.equal(normalizeMineruCloudModel("pipeline"), "pipeline");
      assert.equal(normalizeMineruCloudModel("vlm"), "vlm");
    });

    it("falls back to vlm for unknown or empty values", function () {
      assert.equal(DEFAULT_MINERU_CLOUD_MODEL, "vlm");
      assert.equal(normalizeMineruCloudModel(""), "vlm");
      assert.equal(normalizeMineruCloudModel(undefined), "vlm");
      assert.equal(normalizeMineruCloudModel("MinerU-HTML"), "vlm");
      assert.equal(normalizeMineruCloudModel("vlm-auto-engine"), "vlm");
    });
  });

  describe("normalizeMineruForceOcr", function () {
    it("defaults to disabled force OCR", function () {
      assert.equal(DEFAULT_MINERU_FORCE_OCR, false);
      assert.equal(normalizeMineruForceOcr(undefined), false);
      assert.equal(normalizeMineruForceOcr(""), false);
      assert.equal(normalizeMineruForceOcr("false"), false);
      assert.equal(normalizeMineruForceOcr(false), false);
    });

    it("accepts boolean true and string true", function () {
      assert.equal(normalizeMineruForceOcr(true), true);
      assert.equal(normalizeMineruForceOcr("true"), true);
      assert.equal(normalizeMineruForceOcr("TRUE"), true);
    });
  });

  describe("toMineruApiBackend", function () {
    it("maps short codes to MinerU API backend values", function () {
      assert.equal(toMineruApiBackend("pipeline"), "pipeline");
      assert.equal(toMineruApiBackend("vlm"), "vlm-auto-engine");
      assert.equal(toMineruApiBackend("hybrid"), "hybrid-auto-engine");
    });
  });

  describe("normalizeMineruMaxAutoPages", function () {
    it("preserves zero as Unlimited", function () {
      assert.equal(normalizeMineruMaxAutoPages(0), 0);
      assert.equal(normalizeMineruMaxAutoPages("0"), 0);
    });
    it("accepts positive page limits and floors decimals", function () {
      assert.equal(normalizeMineruMaxAutoPages("100"), 100);
      assert.equal(normalizeMineruMaxAutoPages(100.9), 100);
    });

    it("falls back to the default for empty or invalid values", function () {
      assert.equal(
        normalizeMineruMaxAutoPages(""),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
      assert.equal(
        normalizeMineruMaxAutoPages(-1),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
      assert.equal(
        normalizeMineruMaxAutoPages(undefined),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
      assert.equal(
        normalizeMineruMaxAutoPages(false),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
      assert.equal(
        normalizeMineruMaxAutoPages("not a number"),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
    });
  });

  describe("buildMineruFilenameMatcher", function () {
    it("matches plain substring patterns case-insensitively", function () {
      const matcher = buildMineruFilenameMatcher(["_translated"]);
      assert.isTrue(matcher.matches("Paper_TRANSLATED.pdf"));
      assert.isFalse(matcher.matches("paper-original.pdf"));
    });

    it("matches regex patterns case-insensitively", function () {
      const matcher = buildMineruFilenameMatcher(["/\\btranslat(ed|ion)\\b/"]);
      assert.isTrue(matcher.matches("Machine Translation.pdf"));
      assert.isTrue(matcher.matches("paper translated.pdf"));
      assert.isFalse(matcher.matches("paper transform.pdf"));
    });

    it("ignores invalid regex patterns", function () {
      const matcher = buildMineruFilenameMatcher(["/[invalid/"]);
      assert.isFalse(matcher.matches("invalid.pdf"));
    });

    it("ignores overly long patterns", function () {
      const matcher = buildMineruFilenameMatcher([
        "x".repeat(MAX_MINERU_FILENAME_PATTERN_LENGTH + 1),
      ]);
      assert.isFalse(
        matcher.matches("x".repeat(MAX_MINERU_FILENAME_PATTERN_LENGTH + 1)),
      );
      const boundary = "x".repeat(MAX_MINERU_FILENAME_PATTERN_LENGTH);
      assert.isTrue(buildMineruFilenameMatcher([boundary]).matches(boundary));
    });
  });
});
