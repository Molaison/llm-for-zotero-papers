import { createQuotaReader, readApiQuota } from "../../providers/quota";
import { readCodexQuota } from "../../codexAppServer/quota";

// Shared by all panels; the view owns only presentation and selection races.
export const readFooterQuota = createQuotaReader((target) =>
  target.kind === "codex"
    ? readCodexQuota(target.codexPath)
    : readApiQuota(target),
);
