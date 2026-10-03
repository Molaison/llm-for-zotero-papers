export class MineruCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "MineruCancelledError";
  }
}
