import { config } from "../../package.json";

export class PdfSplitterCancelledError extends Error {
  constructor() {
    super("PDF preparation cancelled");
    this.name = "PdfSplitterCancelledError";
  }
}

export type PdfSplitterSession = {
  pageCount: number;
  extractPages: (startPage: number, endPage: number) => Promise<Uint8Array>;
  close: () => void;
};

/** One worker owns one source PDF, and is terminated on cancellation or close. */
export async function openPdfSplitter(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<PdfSplitterSession> {
  if (signal?.aborted) throw new PdfSplitterCancelledError();
  const WorkerCtor = (
    Zotero.getMainWindow() as unknown as Window & { Worker: typeof Worker }
  ).Worker;
  const worker = new WorkerCtor(
    `chrome://${config.addonRef}/content/scripts/pdfSplitterWorker.js`,
  );
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (data: any) => void; reject: (error: Error) => void }
  >();
  const close = (error = new PdfSplitterCancelledError()) => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", abort);
    worker.terminate();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const abort = () => close();
  worker.onmessage = (event) => {
    const { data } = event as MessageEvent;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    close(new Error(`PDF preparation worker failed: ${event.message}`));
  };
  signal?.addEventListener("abort", abort, { once: true });
  const request = (
    data: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<any> => {
    if (closed || signal?.aborted)
      return Promise.reject(new PdfSplitterCancelledError());
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, ...data }, transfer);
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };
  try {
    const buffer = new Uint8Array(bytes).buffer;
    const opened = await request({ action: "open", bytes: buffer }, [buffer]);
    return {
      pageCount: opened.pageCount,
      extractPages: async (startPage, endPage) => {
        const result = await request({ action: "extract", startPage, endPage });
        return new Uint8Array(result.bytes);
      },
      close: () => close(),
    };
  } catch (error) {
    close();
    throw error;
  }
}
