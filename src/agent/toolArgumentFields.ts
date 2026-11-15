export const FILE_IO_CONTENT_FIELDS = [
  "content",
  "text",
  "contents",
  "data",
] as const;

export const CONTENT_LIKE_ARGUMENT_KEYS = [
  ...FILE_IO_CONTENT_FIELDS,
  "body",
  "code",
  "script",
  "source",
] as const;
