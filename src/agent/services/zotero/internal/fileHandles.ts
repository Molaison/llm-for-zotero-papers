/**
 * Builds the file handle Zotero's file APIs expect.
 *
 * Zotero accepts an `nsIFile` on these paths and a plain path string on some
 * of them; constructing the `nsIFile` when `Components` is available keeps
 * both happy, and falling back to the string keeps this callable from the
 * node test harness.
 */
export function toLocalFileHandle(filePath: string): unknown {
  try {
    const components = (
      globalThis as unknown as {
        Components?: {
          classes: Record<
            string,
            { createInstance: (iid: unknown) => unknown }
          >;
          interfaces: Record<string, unknown>;
        };
      }
    ).Components;
    if (components?.classes?.["@mozilla.org/file/local;1"]) {
      const file = components.classes[
        "@mozilla.org/file/local;1"
      ].createInstance(components.interfaces.nsIFile) as {
        initWithPath: (path: string) => void;
      };
      file.initWithPath(filePath);
      return file;
    }
  } catch {
    // Fall through to the path string.
  }
  return filePath;
}
