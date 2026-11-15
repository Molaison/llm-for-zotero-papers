import { assert } from "chai";
import {
  createLibrarySearchTool,
  LIBRARY_SEARCH_GUIDANCE,
} from "../src/agent/tools/read/librarySearch";

/**
 * The advanced-conditions and trash rules are delivered when they apply (a
 * failed or empty search) instead of on every library-level turn.
 */
describe("library_search result-time guidance", function () {
  async function run(
    gateway: Record<string, unknown>,
    args: Record<string, unknown>,
  ) {
    const tool = createLibrarySearchTool({
      getActiveContextItem: () => null,
      ...gateway,
    } as never);
    const parsed = tool.validate({ libraryID: 1, ...args });
    assert.isTrue(parsed.ok, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error("validation failed");
    return (await tool.execute(parsed.value, {} as never)) as Record<
      string,
      any
    >;
  }

  it("keeps only a short core on every library-level turn", function () {
    assert.isAtMost(LIBRARY_SEARCH_GUIDANCE.instruction.length, 320);
    assert.include(LIBRARY_SEARCH_GUIDANCE.instruction, "conditions[]");
    assert.include(LIBRARY_SEARCH_GUIDANCE.instruction, "deleted:true");
  });

  it("points an empty plain search at the trash", async function () {
    const result = await run(
      { searchAllLibraryItems: async () => ({ items: [], totalCount: 0 }) },
      { entity: "items", mode: "search", text: "grid cells" },
    );
    assert.include(result.guidance, "filters:{deleted:true}");
    assert.include(result.guidance, "mode:'restore'");
  });

  it("adds no guidance to a search that found rows or already searched the trash", async function () {
    const found = await run(
      {
        searchAllLibraryItems: async () => ({
          items: [{ id: 1, title: "A" }],
          totalCount: 1,
        }),
        getItem: () => null,
      },
      { entity: "items", mode: "search", text: "grid cells" },
    );
    assert.notProperty(found, "guidance");
    const trashed = await run(
      { searchAllLibraryItems: async () => ({ items: [], totalCount: 0 }) },
      {
        entity: "items",
        mode: "search",
        text: "grid cells",
        filters: { deleted: true },
      },
    );
    assert.notProperty(trashed, "guidance");
  });

  it("explains child-item conditions and joinMode on an empty advanced search", async function () {
    const result = await run(
      {
        searchItemsByConditions: async () => ({
          items: [],
          totalCount: 0,
          returnedCount: 0,
          offset: 0,
        }),
      },
      {
        entity: "items",
        mode: "search",
        conditions: [
          { condition: "fulltextContent", operator: "contains", value: "x" },
        ],
      },
    );
    assert.include(result.guidance, "resolveToParents:true");
    assert.include(result.guidance, "joinMode:'any'");
    assert.include(result.guidance, "filters:{deleted:true}");
  });

  it("carries the conditions vocabulary on an advanced-search error", async function () {
    let message = "";
    try {
      await run(
        {
          searchItemsByConditions: async () => {
            throw new Error(
              "year does not accept isGreaterThan. Valid operators: is, isNot",
            );
          },
        },
        {
          entity: "items",
          mode: "search",
          conditions: [
            { condition: "year", operator: "isGreaterThan", value: "2020" },
          ],
        },
      );
      assert.fail("the gateway error must surface");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "Valid operators: is, isNot");
    assert.include(message, "fulltextContent");
    assert.include(message, "retry");
    assert.include(message, "resolveToParents:true");
  });
});
