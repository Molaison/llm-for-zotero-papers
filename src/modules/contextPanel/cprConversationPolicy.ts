import { resolveConfiguredModelCapabilities } from "../../utils/modelProviders";

export const CPR_HISTORY_REWRITE_NOTICE =
  "此会话保留远端历史。请直接发送新的追问；暂不支持修改旧问题或重新生成。";

type StoredModelIdentity = {
  modelEntryId?: string;
  modelName?: string;
};
type TargetModelIdentity = {
  modelEntryId?: string;
  model?: string;
  apiBase?: string;
};

/** A local rewrite cannot rewind an append-only remote conversation. */
export function isCprHistoryRewrite(
  original: StoredModelIdentity,
  target?: TargetModelIdentity,
  removedHistory: readonly StoredModelIdentity[] = [],
): boolean {
  const before = resolveConfiguredModelCapabilities({
    entryId: original.modelEntryId,
    model: original.modelName,
  });
  const after = target
    ? resolveConfiguredModelCapabilities({
        entryId: target.modelEntryId,
        model: target.model,
        apiBase: target.apiBase,
      })
    : undefined;
  return (
    before.paperRegistry ||
    before.directWebPdf ||
    Boolean(after?.paperRegistry || after?.directWebPdf) ||
    removedHistory.some((message) => isCprHistoryRewrite(message))
  );
}
