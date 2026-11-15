import { assert } from "chai";
import {
  buildMineruPageRanges,
  mergeMineruChunkResults,
} from "../src/utils/mineruChunking";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function file(relativePath: string, content: string) {
  return { relativePath, data: encoder.encode(content) };
}

describe("mineruChunking", function () {
  it("rejects a missing Markdown image even if absent from the content list", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 1, total: 1 },
            result: {
              mdContent: "![lost](images/missing.png)",
              files: [file("content_list.json", "[]")],
            },
          },
        ]),
      /missing.*asset/i,
    );
  });
  it("keeps PDFs at or below 200 pages in one range", function () {
    assert.deepEqual(buildMineruPageRanges(199), [
      { index: 0, startPage: 1, endPage: 199, total: 199 },
    ]);
    assert.deepEqual(buildMineruPageRanges(200), [
      { index: 0, startPage: 1, endPage: 200, total: 200 },
    ]);
  });

  it("splits longer PDFs into consecutive 200-page ranges", function () {
    assert.deepEqual(buildMineruPageRanges(401), [
      { index: 0, startPage: 1, endPage: 200, total: 401 },
      { index: 1, startPage: 201, endPage: 400, total: 401 },
      { index: 2, startPage: 401, endPage: 401, total: 401 },
    ]);
  });

  it("merges chunks while isolating assets and offsetting page indexes", function () {
    const merged = mergeMineruChunkResults([
      {
        range: { index: 0, startPage: 1, endPage: 2, total: 4 },
        result: {
          mdContent: "# First\n\n![figure](images/figure.png)",
          files: [
            file("full.md", "ignored"),
            file(
              "content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("images/figure.png", "first image"),
          ],
        },
      },
      {
        range: { index: 1, startPage: 3, endPage: 4, total: 4 },
        result: {
          mdContent: "# Second\n\n![figure](images/figure.png)",
          files: [
            file("full.md", "ignored"),
            file(
              "content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("images/figure.png", "second image"),
          ],
        },
      },
    ]);

    assert.include(merged.mdContent, "images/chunk-001/images/figure.png");
    assert.include(merged.mdContent, "images/chunk-002/images/figure.png");
    assert.deepEqual(
      merged.files.map((item) => item.relativePath),
      [
        "images/chunk-001/images/figure.png",
        "images/chunk-002/images/figure.png",
        "content_list.json",
      ],
    );

    assert.equal(decoder.decode(merged.files[0].data), "first image");
    assert.equal(decoder.decode(merged.files[1].data), "second image");
    const contentList = JSON.parse(
      decoder.decode(
        merged.files.find((item) => item.relativePath === "content_list.json")
          ?.data,
      ),
    ) as Array<{ page_idx: number; img_path: string }>;
    assert.deepEqual(contentList, [
      {
        page_idx: 0,
        img_path: "images/chunk-001/images/figure.png",
      },
      {
        page_idx: 2,
        img_path: "images/chunk-002/images/figure.png",
      },
    ]);
  });

  it("rewrites paths from MinerU archives with a job/auto container", function () {
    const merged = mergeMineruChunkResults([
      {
        range: { index: 0, startPage: 1, endPage: 1, total: 1 },
        result: {
          mdContent: "![figure](images/figure.png)",
          files: [
            file("job-id/auto/job-id.md", "ignored"),
            file(
              "job-id/auto/job-id_content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("job-id/auto/images/figure.png", "image"),
          ],
        },
      },
    ]);

    assert.include(merged.mdContent, "images/chunk-001/images/figure.png");
    assert.include(
      decoder.decode(
        merged.files.find((item) => item.relativePath === "content_list.json")
          ?.data,
      ),
      "images/chunk-001/images/figure.png",
    );
    assert.include(
      merged.files.map((item) => item.relativePath),
      "images/chunk-001/images/figure.png",
    );
  });

  it("rewrites a relative Markdown image target exactly once", function () {
    const merged = mergeMineruChunkResults([
      {
        range: { index: 0, startPage: 1, endPage: 1, total: 1 },
        result: {
          mdContent: "![figure](./images/figure.png)",
          files: [
            file("full.md", "ignored"),
            file(
              "content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("images/figure.png", "image"),
          ],
        },
      },
    ]);

    assert.equal(
      merged.mdContent,
      "<!-- MinerU pages 1-1 -->\n\n![figure](images/chunk-001/images/figure.png)",
    );
  });

  it("rewrites a full job/auto Markdown image target exactly once", function () {
    const merged = mergeMineruChunkResults([
      {
        range: { index: 0, startPage: 1, endPage: 1, total: 1 },
        result: {
          mdContent: "![figure](job-id/auto/images/figure.png)",
          files: [
            file("job-id/auto/full.md", "ignored"),
            file(
              "job-id/auto/content_list.json",
              '[{"page_idx":0,"img_path":"images/figure.png"}]',
            ),
            file("job-id/auto/images/figure.png", "image"),
          ],
        },
      },
    ]);

    assert.equal(
      merged.mdContent,
      "<!-- MinerU pages 1-1 -->\n\n![figure](images/chunk-001/images/figure.png)",
    );
  });

  it("rejects chunk ranges with gaps before merging", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 2, total: 4 },
            result: { mdContent: "first", files: [] },
          },
          {
            range: { index: 1, startPage: 4, endPage: 4, total: 4 },
            result: { mdContent: "second", files: [] },
          },
        ]),
      /contiguous/i,
    );
  });

  it("rejects overlapping chunk ranges before merging", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 2, total: 4 },
            result: { mdContent: "first", files: [] },
          },
          {
            range: { index: 1, startPage: 2, endPage: 4, total: 4 },
            result: { mdContent: "second", files: [] },
          },
        ]),
      /contiguous/i,
    );
  });

  it("rejects content-list page indexes outside their source chunk", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 2, total: 2 },
            result: {
              mdContent: "content",
              files: [
                file("content_list.json", '[{"type":"text","page_idx":2}]'),
              ],
            },
          },
        ]),
      /page_idx.*outside/i,
    );
  });

  it("rejects an invalid chunk content list instead of silently dropping it", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 1, total: 1 },
            result: {
              mdContent: "content",
              files: [file("content_list.json", "not json")],
            },
          },
        ]),
      /valid.*content list/i,
    );
  });

  it("rejects a chunk with no content list", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 1, total: 1 },
            result: { mdContent: "content", files: [] },
          },
        ]),
      /content list/i,
    );
  });

  it("rejects content-list paths whose chunk assets are missing", function () {
    assert.throws(
      () =>
        mergeMineruChunkResults([
          {
            range: { index: 0, startPage: 1, endPage: 1, total: 1 },
            result: {
              mdContent: "content",
              files: [
                file(
                  "content_list.json",
                  '[{"type":"image","page_idx":0,"img_path":"images/missing.png"}]',
                ),
              ],
            },
          },
        ]),
      /missing.*asset/i,
    );
  });
});
