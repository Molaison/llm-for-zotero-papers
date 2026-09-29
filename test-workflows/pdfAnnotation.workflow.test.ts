import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";

declare const Zotero: any;
declare const IOUtils: any;
declare const Services: any;

const quote =
  "Representational drift reflects the interplay between plasticity and stability. It can inform continual learning.";

describe("native PDF annotation workflow", function () {
  this.timeout(90000);
  const created: number[] = [];
  let attachment: any;
  let paper: any;
  let path: string;
  let context: any;
  const tool = () =>
    Zotero.LLMForZotero.api.agent.getToolDefinition("annotate_pdf");
  const content = (result: any) => result.content || result;

  before(async function () {
    paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", "Annotation acceptance fixture");
    await paper.saveTx();
    created.push(paper.id);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    const lines = [
      "Representational drift reflects the interplay",
      "between plasticity and stability.",
      "It can inform continual learning.",
    ];
    lines.forEach((line, i) =>
      page.drawText(line, { x: 300, y: 600 - 18 * i, size: 10, font }),
    );
    page.drawText("Unrelated text in the left column.", {
      x: 35,
      y: 600,
      size: 10,
      font,
    });
    const second = pdf.addPage([612, 792]);
    second.drawText("Repeated passage.", { x: 35, y: 600, size: 10, font });
    second.drawText("Repeated passage.", { x: 35, y: 500, size: 10, font });
    path = PathUtils.join(
      Zotero.getTempDirectory().path,
      `annotation-${Date.now()}.pdf`,
    );
    await IOUtils.write(path, await pdf.save());
    attachment = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID: paper.id,
    });
    created.push(attachment.id);
    context = {
      request: {
        conversationKey: paper.id,
        libraryID: paper.libraryID,
        mode: "agent",
        userText: "Annotate the conclusion",
      },
      item: paper,
      modelName: "workflow",
      currentAnswerText: "",
    };
  });

  after(async function () {
    for (const id of [...created].reverse()) {
      const reader = Zotero.Reader._readers.find((r: any) => r.itemID === id);
      if (reader) await reader.close();
      const item = Zotero.Items.get(id);
      if (item) await item.eraseTx();
    }
    if (path) await IOUtils.remove(path, { ignoreAbsent: true });
  });

  it("creates a line-fitting highlight from a quote and verifies native fields", async function () {
    const definition = tool();
    const input = definition.validate({
      attachmentId: attachment.id,
      text: quote,
      comment: "Core conclusion",
      color: "yellow",
    });
    assert.isTrue(input.ok, JSON.stringify(input));
    const contract = new ActionContractService(new ZoteroGateway());
    const prepared = await contract.prepare(definition, input.value);
    const result = await definition.execute(input.value, context);
    const saved = Zotero.Items.get(content(result).annotationId);
    assert.isTrue(saved.isAnnotation());
    assert.equal(saved.parentID, attachment.id);
    assert.equal(saved.annotationText, quote);
    assert.equal(saved.annotationComment, "Core conclusion");
    const position = JSON.parse(saved.annotationPosition);
    assert.equal(position.pageIndex, 0);
    assert.lengthOf(position.rects, 3);
    for (const rect of position.rects) {
      assert.isAtLeast(rect[0], 299);
      assert.isBelow(rect[3] - rect[1], 17);
    }
    assert.isBelow(position.rects[2][2], position.rects[0][2]);
    const receipts = await contract.finalize(undefined, prepared, {
      ok: true,
      effect: result.effect,
      content: result.content,
      actionEvidence: result.actionEvidence,
    });
    assert.equal(receipts[0].verification, "verified");
    const retried = await definition.execute(input.value, context);
    assert.equal(content(retried).annotationId, saved.id);
    assert.equal(content(retried).status, "already_exists");
    assert.lengthOf(attachment.getAnnotations(), 1);
    const read =
      Zotero.LLMForZotero.api.agent.getToolDefinition("library_read");
    for (const id of [paper.id, attachment.id]) {
      const parsed = read.validate({
        itemIds: [id],
        sections: ["annotations"],
      });
      const response = content(await read.execute(parsed.value, context));
      assert.include(
        response.results[String(id)].annotations.map(
          (a: any) => a.annotationId,
        ),
        saved.id,
      );
    }
  });

  it("does not write on missing or ambiguous text and resolves a specified occurrence", async function () {
    const before = attachment.getAnnotations().length;
    for (const text of [
      "This sentence is absent from the PDF.",
      "Repeated passage.",
    ]) {
      const parsed = tool().validate({ attachmentId: attachment.id, text });
      let failed = false;
      try {
        await tool().execute(parsed.value, context);
      } catch {
        failed = true;
      }
      assert.isTrue(failed);
      assert.lengthOf(attachment.getAnnotations(), before);
    }
    const parsed = tool().validate({
      attachmentId: attachment.id,
      text: "Repeated passage.",
      pageIndex: 1,
      occurrence: 2,
    });
    const result = content(await tool().execute(parsed.value, context));
    const position = JSON.parse(
      Zotero.Items.get(result.annotationId).annotationPosition,
    );
    assert.equal(position.pageIndex, 1);
    assert.isBelow(position.rects[0][3], 520);
  });

  const realPdf = String(
    Services.env.get("LLM_FOR_ZOTERO_ANNOTATION_PDF") || "",
  );
  (realPdf ? it : it.skip)(
    "annotates the original representational-drift conclusion on page eight",
    async function () {
      const real = await Zotero.Attachments.importFromFile({
        file: realPdf,
        parentItemID: paper.id,
      });
      created.push(real.id);
      const text =
        "In conclusion, representational drift may reflect the interplay between processes that promote plasticity and those that actively maintain performance stability. As such, representational drift provides a unique insight into how a stability-plasticity trade-off is implemented in the brain, and could inform future approaches to continual learning in AI.";
      const parsed = tool().validate({
        attachmentId: real.id,
        text,
        comment: "Core conclusion",
      });
      const start = Date.now();
      const result = content(await tool().execute(parsed.value, context));
      const saved = Zotero.Items.get(result.annotationId);
      const position = JSON.parse(saved.annotationPosition);
      assert.equal(position.pageIndex, 7);
      assert.isAtLeast(position.rects.length, 5);
      assert.equal(saved.annotationComment, "Core conclusion");
      Zotero.debug(
        `[annotation-acceptance] original paper: ${position.rects.length} lines; ${Date.now() - start}ms`,
      );
    },
  );
});
