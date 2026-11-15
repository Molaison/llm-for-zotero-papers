import type { JourneyContext } from "./journeys";
import { assertExact, check } from "./core";
import { requireReceipt } from "./driver";
import { snapshot, onlyChanges } from "./native";
import { PdfPageService } from "../src/agent/services/pdfPageService";
import { sha256Bytes } from "../src/agent/store/journalRecoveryBlobStore";
import { getPendingRequestId } from "../src/modules/contextPanel/state";

declare const Zotero: any;
declare const IOUtils: any;

export async function figureCommandJourney(ctx: JourneyContext) {
  const id = "figures.auto-script";
  const verified = JSON.parse(
    await IOUtils.readUTF8(
      `${ctx.request.reportDir}/figures.crop-note.auto/verified.json`,
    ),
  );
  const path = verified.figures[0].cropPath;
  const bytes = await IOUtils.read(path);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = `${header.getUint32(16)}x${header.getUint32(20)}`;
  const script = `${ctx.request.reportDir}/vault/inspect-image.py`;
  const before = await snapshot();
  const turn = await ctx.driver.turn(
    id,
    `Create a temporary Python script at "${script}" that reads only the PNG header of "${path}" using the Python standard library and prints WIDTHxHEIGHT. Run the script with python3 and report the dimensions. Preserve the image and do not change Zotero.`,
    "auto",
  );
  const commands = turn.events.filter(
    (event) => event.type === "tool_result" && event.name === "run_command",
  );
  check(
    commands.length > 0 &&
      commands.some(
        (event) =>
          event.type === "tool_result" &&
          JSON.stringify(event.content).includes(dimensions),
      ),
    "The real Python command did not return the image dimensions",
  );
  check(await IOUtils.exists(script), "The requested script was not created");
  assertExact(
    await snapshot(),
    before,
    "Image inspection did not change Zotero",
  );
  assertExact(
    await sha256Bytes(await IOUtils.read(path)),
    await sha256Bytes(bytes),
    "Image inspection preserved the crop bytes",
  );
  await ctx.write(`${id}/verified.json`, {
    dimensions,
    script,
    runId: turn.result.runId,
  });
}

/** Real-source regression: two attachments named PDF, only one is the active paper. */
export async function figureNoteJourney(id: string, ctx: JourneyContext) {
  const { harness, driver, write, fixtures } = ctx;
  const title =
    "Time and experience differentially affect distinct aspects of hippocampal representational drift";
  const source = (await Zotero.Items.getAll(fixtures.libraryID)).find(
    (item: any) =>
      item.isRegularItem() &&
      item.getField("title") === title &&
      !item.getTags().some((tag: any) => tag.tag === "figure-note-regression"),
  );
  check(source, `Required dev-library source is missing: ${title}`);
  const sourceAttachments = source
    .getAttachments()
    .map((itemId: number) => Zotero.Items.get(itemId));
  const sourcePdf = sourceAttachments.find((item: any) =>
    item.attachmentFilename?.startsWith("Geva et al."),
  );
  const commentary = sourceAttachments.find((item: any) =>
    item.attachmentFilename?.startsWith("Lee and Brandon"),
  );
  check(
    sourcePdf && commentary,
    "The regression needs both the source PDF and the misleading sibling PDF",
  );
  const paper = new Zotero.Item("journalArticle");
  paper.libraryID = fixtures.libraryID;
  paper.setField("title", title);
  paper.setField("date", source.getField("date"));
  paper.setCreators(source.getCreators());
  paper.setTags([{ tag: "figure-note-regression" }]);
  paper.setCollections([fixtures.root.id]);
  await paper.saveTx();
  const attachments = [];
  for (const original of [sourcePdf, commentary]) {
    const path = await original.getFilePathAsync();
    check(
      path && (await IOUtils.exists(path)),
      "Source PDF bytes are unavailable in zotero-dev",
    );
    attachments.push(
      await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID: paper.id,
        title: "PDF",
      }),
    );
  }
  const activePdf = attachments[0];
  const mode = id.endsWith("yolo") ? "yolo" : "auto";
  const labels = mode === "auto" ? ["Figure 1"] : ["Figure 2", "Figure 3"];
  const prompt =
    mode === "auto"
      ? "can you crop th figure 1 for me and save it into my zotero note?"
      : "Can you crop Figures 2 and 3 and save both in one Zotero note attached to this paper?";
  await write(`${id}/fixture.json`, {
    paperId: paper.id,
    activePdfId: activePdf.id,
    siblingPdfId: attachments[1].id,
    labels,
    prompt,
  });
  await harness.openStandaloneForItem(activePdf.id);
  await harness.clickStandaloneTab("paper");
  Zotero.getMainWindow().document.title =
    "Zotero-dev — Figure extraction acceptance";
  Zotero.LLMForZotero.data.standaloneWindow.document.title =
    "Zotero-dev — Crop-to-note acceptance";
  harness.enableLiveAgentSending();
  const before = await snapshot();
  const extractionCalls: unknown[] = [];
  const originalExtraction =
    PdfPageService.prototype.extractFiguresFromSourcePdf;
  // Observe the real extractor, including its real subprocess; never replace its result.
  PdfPageService.prototype.extractFiguresFromSourcePdf = async function (
    params,
  ) {
    const started = Date.now();
    const result = await originalExtraction.call(this, params);
    extractionCalls.push({
      attachmentId: params.paperContext?.contextItemId,
      selection: params.selection,
      elapsedMs: Date.now() - started,
      result,
    });
    await write(`${id}/python-extraction.json`, extractionCalls);
    return result;
  };
  let turn;
  try {
    turn = await driver.turn(
      id,
      prompt,
      mode,
      { conversationKey: paper.id, activeItemId: paper.id },
      "none",
      () => harness.askStandalone(prompt),
    );
  } finally {
    PdfPageService.prototype.extractFiguresFromSourcePdf = originalExtraction;
  }
  const calls = turn.events.filter((event) => event.type === "tool_call");
  check(
    !calls.some((event) =>
      ["run_command", "zotero_script"].includes(event.name),
    ),
    "The native figure workflow detoured into shell or Zotero scripts",
  );
  check(
    calls.some((event) => event.name === "note_write"),
    "The native note tool was not used",
  );
  check(
    extractionCalls.length > 0,
    "Fresh source PDF never reached the bundled Python extraction path",
  );
  const firstCall = turn.events.findIndex(
    (event) => event.type === "tool_call",
  );
  for (const skill of ["analyze-figures", "write-note"]) {
    const index = turn.events.findIndex(
      (event) =>
        event.type === "status" && event.text === `Skill activated: ${skill}`,
    );
    check(
      index >= 0 && index < firstCall,
      `${skill} guidance did not load before work began`,
    );
  }
  const figures = turn.events.flatMap((event) =>
    event.type === "tool_result" && event.name === "paper_read"
      ? (event.content as any)?.figures || []
      : [],
  );
  assertExact(
    figures.map((figure: any) => figure.label).sort(),
    labels,
    "Exact requested figures were extracted",
  );
  check(
    figures.every(
      (figure: any) => figure.paperContext.contextItemId === activePdf.id,
    ),
    "A figure came from the commentary PDF",
  );
  if (mode === "auto") {
    check(
      figures[0].rect.top > 140 &&
        figures[0].rect.top < 154 &&
        figures[0].rect.left > 125,
      "The Figure 1 crop includes publisher furniture or loses its panel labels",
    );
  } else {
    const figure = figures.find((entry: any) => entry.label === "Figure 3");
    check(
      figure.rect.top > 126 &&
        figure.rect.top <= 154 &&
        figure.rect.left <= 155 &&
        figure.rect.top + figure.rect.height >= 1048,
      "The cross-page Figure 3 crop loses panel or axis labels, or includes the publisher header",
    );
  }
  await paper.reload(undefined, true);
  assertExact(paper.getNotes().length, 1, "Exactly one native child note");
  const note = Zotero.Items.get(paper.getNotes()[0]);
  await note.reload(undefined, true);
  assertExact(note.parentID, paper.id, "Native note parent");
  const html = note.getNote();
  check(
    !/<h[2-6][^>]*>\s*(?:Summary|Key Findings|Methodology|My Notes|References)\s*<\/h[2-6]>/i.test(
      html,
    ),
    "A crop-only request was expanded into an unrequested reading-note template",
  );
  const keys = [...html.matchAll(/data-attachment-key="([^"]+)"/g)].map(
    (match: RegExpMatchArray) => match[1],
  );
  assertExact(
    keys.length,
    labels.length,
    "Every figure is embedded in the actual saved note",
  );
  const expectedHashes = await Promise.all(
    figures.map(async (figure: any) =>
      sha256Bytes(await IOUtils.read(figure.cropPath)),
    ),
  );
  const embedded = [];
  for (const key of keys) {
    const image = Zotero.Items.getByLibraryAndKey(paper.libraryID, key);
    check(
      image && image.parentID === note.id,
      "The saved image is not a native child of the note",
    );
    embedded.push({
      id: image.id,
      hash: await sha256Bytes(
        await IOUtils.read(await image.getFilePathAsync()),
      ),
    });
  }
  assertExact(
    embedded.map((image) => image.hash).sort(),
    expectedHashes.sort(),
    "Native embedded image bytes equal the extracted crops",
  );
  requireReceipt(turn);
  const allowedIds = new Set([note.id, ...embedded.map((image) => image.id)]);
  onlyChanges(
    before,
    await snapshot(),
    (change) => !change.before && allowedIds.has(change.after?.id),
  );
  await write(`${id}/native-note.html`, html, true);
  await write(`${id}/verified.json`, {
    runId: turn.result.runId,
    paperId: paper.id,
    activePdfId: activePdf.id,
    noteId: note.id,
    figures,
    embedded,
    tools: calls.map((event) => event.name),
  });
  const deadline = Date.now() + 15_000;
  while (getPendingRequestId(paper.id) && Date.now() < deadline)
    await Zotero.Promise.delay(50);
  check(
    !getPendingRequestId(paper.id),
    "The UI did not finish delivering the saved note",
  );
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/completed.png`,
  );
}
