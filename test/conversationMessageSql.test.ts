import { assert } from "chai";
import {
  buildLatestStoredMessagesQuery,
  storedMessageDisplayOrderSql,
  storedMessageRoleOrderSql,
} from "../src/shared/conversationMessageSql";

describe("conversation message SQL helpers", function () {
  it("orders same-timestamp messages with users before assistants", function () {
    assert.equal(
      storedMessageRoleOrderSql(),
      "CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END",
    );
    assert.equal(
      storedMessageDisplayOrderSql(),
      "timestamp ASC, CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END ASC, id ASC",
    );
  });

  it("selects the latest limited window before returning display order", function () {
    const sql = buildLatestStoredMessagesQuery({
      tableName: "messages",
      selectColumnsSql: "id, role, text, timestamp",
      whereSql: "conversation_id = ?",
    });

    assert.include(
      sql,
      "ORDER BY timestamp DESC, CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END DESC, id DESC",
    );
    assert.include(sql, "LIMIT ?");
    assert.match(
      sql,
      /ORDER BY timestamp ASC, CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END ASC, id ASC\s*$/,
    );
  });
});
