import { Worker as NodeWorker } from "node:worker_threads";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = buildSync({
  entryPoints: [
    fileURLToPath(
      new URL("../../src/utils/pdfSplitterWorker.ts", import.meta.url),
    ),
  ],
  bundle: true,
  write: false,
  platform: "browser",
  target: "firefox115",
}).outputFiles[0].text;
const workers = new Set<NodeWorker>();

/** Runs the exact bundled browser worker in a real Node worker thread. */
class PdfTestWorker {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string; preventDefault: () => void }) => void;
  private worker: NodeWorker;
  constructor(url: string) {
    if (!url.endsWith("/pdfSplitterWorker.js"))
      throw new Error(`Unexpected worker: ${url}`);
    this.worker = new NodeWorker(
      `const { parentPort } = require('node:worker_threads');
      globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
      parentPort.on('message', data => globalThis.onmessage({ data }));\n${bundle}`,
      { eval: true },
    );
    workers.add(this.worker);
    this.worker.on("message", (data) => this.onmessage?.({ data }));
    this.worker.on("error", (error) =>
      this.onerror?.({ message: error.message, preventDefault() {} }),
    );
    this.worker.on("exit", () => workers.delete(this.worker));
  }
  postMessage(message: unknown, transfer: ArrayBuffer[]) {
    this.worker.postMessage(message, transfer);
  }
  terminate() {
    void this.worker.terminate();
  }
}

export function installPdfWorkerTestHost() {
  (globalThis as any).Zotero.getMainWindow = () => ({ Worker: PdfTestWorker });
}
export async function closePdfWorkersForTests() {
  await Promise.all([...workers].map((worker) => worker.terminate()));
  workers.clear();
}
