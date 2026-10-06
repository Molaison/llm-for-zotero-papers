/** Health endpoints for tests whose parsing transport represents a legacy server. */
export function mineruLegacyHealth(url: string): Response | undefined {
  const data = url.endsWith("/v1/health")
    ? {}
    : url.endsWith("/health")
      ? { status: "healthy", version: "3.4.5" }
      : undefined;
  if (!data) return undefined;
  const status = url.endsWith("/v1/health") ? 404 : 200;
  return { status, ok: status === 200, json: async () => data } as Response;
}
