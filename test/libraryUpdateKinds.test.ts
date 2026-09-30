import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";

/**
 * library_update owns collection, attachment, and saved-search updates as
 * kinds. Every routed call below is also checked against the facade's own
 * model-visible schema: the schema says additionalProperties:false, so a kind
 * whose fields are missing from it cannot be expressed by a model that follows
 * the schema, even though validate() would accept the call.
 */

type PropertySchema = {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: PropertySchema[];
};

type ObjectSchema = {
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, PropertySchema>;
};

function typeMatches(value: unknown, schema: PropertySchema): boolean {
  if (schema.anyOf) return schema.anyOf.some((s) => typeMatches(value, s));
  if (!schema.type) return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object")
      return (
        Boolean(value) && typeof value === "object" && !Array.isArray(value)
      );
    return typeof value === type;
  });
}

/** Top-level structural check: known keys, JSON types, and enums. */
function schemaErrors(schema: ObjectSchema, args: Record<string, unknown>) {
  const errors: string[] = [];
  const properties = schema.properties || {};
  for (const key of schema.required || []) {
    if (!(key in args)) errors.push(`missing required ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) {
      if (schema.additionalProperties === false)
        errors.push(`${key} is not in the schema`);
      continue;
    }
    if (!typeMatches(value, property)) errors.push(`${key} has the wrong type`);
    if (property.enum && !property.enum.includes(value))
      errors.push(`${key}=${JSON.stringify(value)} is not in its enum`);
  }
  return errors;
}

describe("library_update kinds", function () {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const tool = registry.getTool("library_update")!;
  const schema = tool.spec.inputSchema as ObjectSchema;

  const ROUTES: Array<{
    args: Record<string, unknown>;
    delegateName: string;
    operation: string;
  }> = [
    {
      args: { kind: "collection", action: "create", name: "New" },
      delegateName: "collection_update",
      operation: "create_collection",
    },
    {
      args: {
        kind: "collection",
        action: "create",
        name: "Child",
        parentCollectionId: 4,
        libraryID: 1,
      },
      delegateName: "collection_update",
      operation: "create_collection",
    },
    {
      args: {
        kind: "collection",
        action: "rename",
        collectionId: 3,
        newName: "Renamed",
      },
      delegateName: "collection_update",
      operation: "update_collection",
    },
    {
      args: {
        kind: "collection",
        action: "move",
        collectionId: 3,
        parentCollectionId: null,
      },
      delegateName: "collection_update",
      operation: "update_collection",
    },
    {
      args: {
        kind: "collection",
        action: "delete",
        collectionId: 3,
        deleteItems: false,
        permanent: false,
      },
      delegateName: "collection_update",
      operation: "delete_collection",
    },
    {
      args: {
        kind: "attachment",
        action: "rename",
        attachmentId: 5,
        newName: "paper.pdf",
      },
      delegateName: "attachment_update",
      operation: "rename_attachment",
    },
    {
      args: {
        kind: "attachment",
        action: "relink",
        attachmentId: 5,
        newPath: "/tmp/paper.pdf",
      },
      delegateName: "attachment_update",
      operation: "relink_attachment",
    },
    {
      args: { kind: "attachment", action: "delete", attachmentId: 5 },
      delegateName: "attachment_update",
      operation: "delete_attachment",
    },
    {
      args: {
        kind: "savedSearch",
        action: "save",
        name: "Unread 2024",
        conditions: [
          { condition: "dateAdded", operator: "isAfter", value: "2024" },
        ],
        joinMode: "all",
      },
      delegateName: "saved_search_update",
      operation: "save_saved_search",
    },
    {
      args: {
        kind: "savedSearch",
        action: "delete",
        savedSearchId: 9,
        permanent: false,
      },
      delegateName: "saved_search_update",
      operation: "delete_saved_search",
    },
    {
      args: {
        kind: "tag",
        action: "rename",
        tag: "ML",
        newTag: "machine learning",
      },
      delegateName: "tag_update",
      operation: "update_library_tag",
    },
    {
      args: {
        kind: "tag",
        action: "setColor",
        tag: "urgent",
        color: "#FF6666",
        position: 0,
        libraryID: 1,
      },
      delegateName: "tag_update",
      operation: "update_library_tag",
    },
  ];

  it("kind:'collection' action:'create' delegates to the collection tool", function () {
    const v = tool.validate({
      kind: "collection",
      action: "create",
      name: "New",
    });
    assert.isTrue(v.ok, v.ok ? "" : v.error);
    assert.equal((v as any).value.delegateName, "collection_update");
  });

  for (const [index, route] of ROUTES.entries()) {
    const label = `${route.args.kind} ${route.args.action} (#${index + 1})`;
    it(`routes ${label} to ${route.delegateName} with a schema-valid call`, function () {
      assert.deepEqual(schemaErrors(schema, route.args), [], label);
      const validated = tool.validate(route.args);
      assert.isTrue(validated.ok, validated.ok ? "" : validated.error);
      if (!validated.ok) return;
      assert.equal(validated.value.delegateName, route.delegateName);
      assert.equal(
        (validated.value.delegateInput as { operation: { type: string } })
          .operation.type,
        route.operation,
      );
    });
  }

  it("declares every operation its new kinds reach", function () {
    assert.includeMembers(tool.effectOperations || [], [
      "create_collection",
      "delete_collection",
      "update_collection",
      "delete_attachment",
      "rename_attachment",
      "relink_attachment",
      "save_saved_search",
      "delete_saved_search",
    ]);
  });

  it("names every kind in its enum and its model description", function () {
    const kinds = (schema.properties?.kind?.enum || []) as string[];
    assert.includeMembers(kinds, ["collection", "attachment", "savedSearch"]);
    const described = registry
      .listTools()
      .find((entry) => entry.name === "library_update")!.description;
    for (const kind of ["collection", "attachment", "savedSearch"]) {
      assert.include(described, kind);
    }
  });

  it("rejects an unknown kind by listing the new ones", function () {
    const validated = tool.validate({ kind: "folder", action: "create" });
    assert.isFalse(validated.ok);
    if (validated.ok) return;
    assert.include(validated.error, "collection");
    assert.include(validated.error, "attachment");
    assert.include(validated.error, "savedSearch");
  });

  it("no longer registers the three single-verb tools and points callers at the kind", async function () {
    for (const [name, hint] of [
      ["collection_update", "library_update kind:'collection'"],
      ["attachment_update", "library_update kind:'attachment'"],
      ["saved_search_update", "library_update kind:'savedSearch'"],
    ]) {
      assert.notExists(registry.getTool(name), `${name} retired`);
      const prepared = await registry.prepareExecution(
        { id: "c1", name, arguments: {} } as any,
        {} as any,
      );
      const text = JSON.stringify(prepared);
      assert.match(text, new RegExp(`Unknown tool: ${name}`));
      assert.include(text, hint);
    }
  });

  it("carries the attachment guidance and matches on the attachment signal", function () {
    const guidance = tool.guidance!;
    assert.include(guidance.instruction, "kind:'attachment'");
    assert.notInclude(guidance.instruction, "attachment_update");
    assert.isTrue(
      guidance.matches(
        { userTextSignals: { mentionsAttachment: true } } as never,
        { matchedSkillIds: [] },
      ),
    );
    assert.isFalse(
      guidance.matches(
        { userTextSignals: { mentionsAttachment: false } } as never,
        { matchedSkillIds: [] },
      ),
    );
  });
});
