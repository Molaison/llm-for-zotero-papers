import { assert } from "chai";
import { resolveActiveLibraryID } from "../src/utils/zoteroLibraryScope";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
} from "../src/agent/mcp/server";

declare const Zotero: any;

describe("active library selection against real Zotero", function () {
  this.timeout(60000);

  it("keeps a group library selected through multiple folders and an MCP read", async function () {
    const pane = Zotero.getActiveZoteroPane();
    assert.isFunction(pane.getSelectedLibraryIDs);
    const tree = pane.collectionsView;
    const originalSelector = pane.getSelectedLibraryID;
    let legacyCalls = 0;
    const group = new Zotero.Group({
      groupID:
        Number(
          await Zotero.DB.valueQueryAsync("SELECT MAX(groupID) FROM groups"),
        ) + 1,
      name: `LibraryScope-${Date.now()}`,
      description: "Disposable library selection regression",
      version: 0,
    });
    group.editable = true;
    group.filesEditable = true;
    await group.saveTx();

    try {
      const collections = [];
      for (const name of ["First", "Second"]) {
        const collection = new Zotero.Collection();
        collection.libraryID = group.libraryID;
        collection.name = `${group.name}-${name}`;
        await collection.saveTx();
        collections.push(collection);
      }
      assert.notEqual(group.libraryID, Zotero.Libraries.userLibraryID);
      assert.equal(
        Number(
          await Zotero.DB.valueQueryAsync(
            "SELECT libraryID FROM collections WHERE collectionID=?",
            [collections[0].id],
          ),
        ),
        group.libraryID,
      );

      // Keep Zotero's actual plural API and collection selection intact.
      // A legacy call must be observable even though the resolver catches errors.
      pane.getSelectedLibraryID = () => {
        legacyCalls++;
        throw new Error("getSelectedLibraryID was removed");
      };
      assert.isTrue(await tree.selectCollection(collections[0].id));
      assert.equal(resolveActiveLibraryID(), group.libraryID);

      const secondRow = tree.getRowIndexByID(`C${collections[1].id}`);
      assert.isNumber(secondRow);
      const selected = tree.waitForSelect();
      tree.selection.toggleSelect(secondRow);
      await selected;
      assert.equal(tree.selection.count, 2);
      assert.deepEqual(pane.getSelectedLibraryIDs(), [group.libraryID]);
      assert.equal(resolveActiveLibraryID(), group.libraryID);

      const Endpoint = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
      const [status, , body] = await new Endpoint().init({
        method: "POST",
        headers: {
          Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
        },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "library_search",
            arguments: { entity: "collections", mode: "list", view: "tree" },
          },
        },
      });
      assert.equal(status, 200);
      const payload = JSON.parse(body);
      assert.isUndefined(payload.error, body);
      assert.isNotTrue(payload.result.isError, body);
      const content = JSON.parse(payload.result.content[0].text);
      assert.isTrue(content.ok, body);
      for (const collection of collections) {
        assert.include(JSON.stringify(content.result), collection.name);
      }
      assert.equal(legacyCalls, 0);

      await tree.selectLibrary(Zotero.Libraries.userLibraryID);
      assert.equal(resolveActiveLibraryID(), Zotero.Libraries.userLibraryID);
      assert.equal(legacyCalls, 0);
    } finally {
      pane.getSelectedLibraryID = originalSelector;
      await tree.selectLibrary(Zotero.Libraries.userLibraryID);
      await group.eraseTx();
    }
  });
});
