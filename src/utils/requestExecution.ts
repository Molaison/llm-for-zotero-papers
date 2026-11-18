export type RequestExecutionState =
  | { kind: "active" }
  | { kind: "succeeded" }
  | { kind: "failed"; error: unknown }
  | { kind: "cancelled"; error: Error };

/** One caller's lifetime. Ending its wait does not undo a started side effect. */
export class RequestExecution<Context = undefined> {
  private currentState: RequestExecutionState = { kind: "active" };
  private readonly stopped: Promise<never>;
  private rejectStopped!: (error: Error) => void;
  private readonly onAbort = () => {
    if (!this.isActive()) return;
    const error = new Error("Aborted");
    error.name = "AbortError";
    this.currentState = { kind: "cancelled", error };
    this.rejectStopped(error);
  };

  constructor(
    readonly context: Context,
    private readonly signal?: AbortSignal,
  ) {
    this.stopped = new Promise<never>((_resolve, reject) => {
      this.rejectStopped = reject;
    });
    void this.stopped.catch(() => undefined);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  get state(): RequestExecutionState {
    return this.currentState;
  }

  isActive(): boolean {
    return this.currentState.kind === "active";
  }

  assertActive(): void {
    const state = this.currentState;
    if (state.kind === "active") return;
    if (state.kind === "failed" || state.kind === "cancelled") {
      throw state.error;
    }
    throw new Error("Request already completed");
  }

  fail(error: unknown): void {
    if (this.isActive()) this.currentState = { kind: "failed", error };
  }

  async wait<Result>(
    operation: () => Result | PromiseLike<Result>,
  ): Promise<Result> {
    this.assertActive();
    const result = await Promise.race([operation(), this.stopped]);
    this.assertActive();
    return result;
  }

  async run<Result>(
    operation: () => Result | PromiseLike<Result>,
  ): Promise<Result> {
    try {
      const result = await this.wait(operation);
      this.assertActive();
      this.currentState = { kind: "succeeded" };
      return result;
    } catch (error) {
      if (this.isActive()) this.currentState = { kind: "failed", error };
      throw error;
    } finally {
      this.signal?.removeEventListener("abort", this.onAbort);
    }
  }
}
