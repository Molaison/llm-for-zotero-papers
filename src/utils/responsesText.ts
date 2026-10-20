export type ResponsesTextPosition = {
  item_id?: unknown;
  output_index?: unknown;
  content_index?: unknown;
};

type TextPart = {
  text: string;
  final: boolean;
  output: number;
  content: number;
};

export class ResponsesText {
  private readonly parts = new Map<string, TextPart>();
  private readonly items = new Map<string, string>();
  private finalText: string | undefined;

  get text(): string {
    return (
      this.finalText ??
      [...this.parts.values()]
        .sort((a, b) => a.output - b.output || a.content - b.content)
        .map((part) => part.text)
        .join("")
    );
  }

  update(
    text: string,
    mode: "delta" | "snapshot" | "final",
    position: ResponsesTextPosition = {},
  ): string {
    if (!text && mode !== "final") return "";
    const index =
      typeof position.output_index === "number"
        ? position.output_index
        : undefined;
    const id =
      typeof position.item_id === "string" ? position.item_id : undefined;
    const item =
      (id ? this.items.get(`id:${id}`) : undefined) ??
      (index === undefined ? undefined : this.items.get(`index:${index}`)) ??
      (index === undefined ? (id ?? "default") : `index:${index}`);
    if (id) this.items.set(`id:${id}`, item);
    if (index !== undefined) this.items.set(`index:${index}`, item);
    const content =
      typeof position.content_index === "number" ? position.content_index : 0;
    const key = `${item}:${content}`;
    const previous = this.parts.get(key);
    if (mode !== "final" && previous?.final) return "";
    const before = previous?.text ?? "";
    const after = mode === "delta" ? before + text : text;
    this.parts.set(key, {
      text: after,
      final: mode === "final" || Boolean(previous?.final),
      output: index ?? previous?.output ?? this.parts.size,
      content,
    });
    return after.startsWith(before) ? after.slice(before.length) : "";
  }

  finish(text: string): string {
    const previous = this.text;
    this.finalText = text;
    // Callbacks can append only; the returned result retains any final correction.
    return text.startsWith(previous) ? text.slice(previous.length) : "";
  }
}
