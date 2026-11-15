export function stripLeadingCitationSeparators(value: string): string {
  return (value || "").replace(/^[\s,;]+/, "").trim();
}
