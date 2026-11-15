export type Disposable = () => void;

export class PanelLifecycle {
  private readonly disposables: Disposable[] = [];
  private disposed = false;

  add(disposable: Disposable): Disposable {
    if (this.disposed) {
      disposable();
      return () => {};
    }
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      const index = this.disposables.indexOf(release);
      if (index >= 0) this.disposables.splice(index, 1);
      disposable();
    };
    this.disposables.push(release);
    return release;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.disposables.splice(0).reverse();
    for (const dispose of pending) {
      try {
        dispose();
      } catch (_err) {
        void _err;
      }
    }
  }
}

export function observeElementDisconnected(
  element: Element,
  onDisconnected: () => void,
): Disposable {
  const ownerWindow = element.ownerDocument?.defaultView;
  const MutationObserverCtor =
    ownerWindow?.MutationObserver ||
    (
      globalThis as typeof globalThis & {
        MutationObserver?: typeof MutationObserver;
      }
    ).MutationObserver;
  if (!MutationObserverCtor || !element.ownerDocument) {
    return () => {};
  }

  let disposed = false;
  const observer = new MutationObserverCtor(() => {
    if (element.isConnected || disposed) return;
    disposed = true;
    observer.disconnect();
    onDisconnected();
  });
  observer.observe(element.ownerDocument, { childList: true, subtree: true });

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
  };
}
