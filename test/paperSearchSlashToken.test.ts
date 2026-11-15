import { assert } from "chai";
import {
  parsePaperSearchSlashToken,
  parseSkillSearchDollarToken,
} from "../src/modules/contextPanel/paperSearch";

describe("paperSearch slash token parsing", function () {
  it("keeps a single-word slash token active before whitespace", function () {
    const input = "/attention is all you need";
    const token = parsePaperSearchSlashToken(input, "/attention".length);

    assert.deepEqual(token, {
      query: "attention",
      slashStart: 0,
      caretEnd: "/attention".length,
    });
  });

  it("dismisses the slash token after typing whitespace", function () {
    const input = "/attention is all you need";
    const token = parsePaperSearchSlashToken(input, input.length);

    assert.isNull(token);
  });

  it("finds the most recent valid slash token in surrounding text", function () {
    const input = "Please compare /transformer 2017 vaswani";
    const token = parsePaperSearchSlashToken(
      input,
      input.indexOf(" ", input.indexOf("/transformer")) >= 0
        ? input.indexOf(" ", input.indexOf("/transformer"))
        : input.length,
    );

    assert.isNotNull(token);
    assert.equal(token?.query, "transformer");
    assert.equal(token?.slashStart, input.indexOf("/transformer"));
  });

  it("ignores slashes that are not preceded by whitespace or start-of-string", function () {
    const input = "Visit https://example.com/paper";
    const token = parsePaperSearchSlashToken(input, input.length);

    assert.isNull(token);
  });

  it("returns null when the caret is before the slash token", function () {
    const input = "prefix /retrieval augmented generation";
    const token = parsePaperSearchSlashToken(input, 4);

    assert.isNull(token);
  });

  it("keeps a dollar skill token active before whitespace", function () {
    const input = "$evidence";
    const token = parseSkillSearchDollarToken(input, input.length);

    assert.deepEqual(token, {
      query: "evidence",
      slashStart: 0,
      caretEnd: input.length,
    });
  });

  it("finds a dollar skill token after whitespace", function () {
    const input = "Use $evidence";
    const token = parseSkillSearchDollarToken(input, input.length);

    assert.deepEqual(token, {
      query: "evidence",
      slashStart: input.indexOf("$evidence"),
      caretEnd: input.length,
    });
  });

  it("ignores dollar skill tokens not preceded by whitespace or start-of-string", function () {
    const input = "abc$evidence";
    const token = parseSkillSearchDollarToken(input, input.length);

    assert.isNull(token);
  });

  it("dismisses dollar skill tokens after whitespace", function () {
    const input = "$evidence based";
    const token = parseSkillSearchDollarToken(input, input.length);

    assert.isNull(token);
  });

  it("dismisses dollar skill tokens after inline math closes", function () {
    assert.isNull(
      parseSkillSearchDollarToken("$something$", "$something$".length),
    );
    assert.isNull(
      parseSkillSearchDollarToken(
        "Please explain $x_i + y_i$ in this model",
        "Please explain $x_i + y_i$".length,
      ),
    );
  });
});
