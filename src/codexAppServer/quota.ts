import { parseCodexQuota } from "../providers/quota";
import { getOrCreateCodexAppServerProcess } from "../utils/codexAppServerProcess";
import { getEffectiveCodexAppServerBinaryPath } from "./binaryPath";
import { CODEX_APP_SERVER_NATIVE_PROCESS_KEY } from "./runtimeCwd";

export async function readCodexQuota(codexPath: string) {
  const proc = await getOrCreateCodexAppServerProcess(
    CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath: getEffectiveCodexAppServerBinaryPath(codexPath) },
  );
  return parseCodexQuota(
    await proc.sendRequest("account/rateLimits/read", {}, 8000),
  );
}
