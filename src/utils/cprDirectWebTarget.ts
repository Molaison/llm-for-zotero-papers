/** Pure CPR direct-Web route detection shared by capability code and transport. */
export const CPR_DIRECT_WEB_API_BASE = "https://cpr.molaisonz.dpdns.org/v1";

export function normalizeCprDirectWebTarget(base: string): string {
  const target = String(base || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/responses$/, "");
  return [
    "http://127.0.0.1:18082/v1",
    "http://192.168.233.231:18082/v1",
    CPR_DIRECT_WEB_API_BASE,
  ].includes(target)
    ? CPR_DIRECT_WEB_API_BASE
    : target;
}

export function isCprDirectWebModel(model: string, apiBase: string): boolean {
  return (
    String(model || "").trim().startsWith("chatgpt-web/") &&
    normalizeCprDirectWebTarget(apiBase) === CPR_DIRECT_WEB_API_BASE
  );
}
