# Selective upstream sync — 2026-10-27

Source: [yilewang/llm-for-zotero](https://github.com/yilewang/llm-for-zotero), targeting the fork's `codex/papers` branch.

## Ported changes

- [3986c91](https://github.com/yilewang/llm-for-zotero/commit/3986c9101efbc05ee87d982decc3a66e4863b78c): reply to the MCP JSON-RPC `ping` health-check request.
- [e970266](https://github.com/yilewang/llm-for-zotero/commit/e970266f93b0f42da0b70ed0805d2c166e2f9144): treat quota and model-list queries as nonfatal timeouts to avoid aborting an active Codex chat turn. Adapted the optional `sendRequest` timeout flag to the fork's older process implementation; preserve the close reason, with local path redaction.
- [95b0f59](https://github.com/yilewang/llm-for-zotero/commit/95b0f591fde472a38933342d508cd87f8b10cb10): retain streamed text after a complete web-source marker. Adapted the punctuation-strip pattern to the fork's existing attribution system.
- [e531884](https://github.com/yilewang/llm-for-zotero/commit/e531884ad738b9ca6bb24634cbd4b7409e98bf7e): avoid parsing PDFs merely on opening a reader, and prewarm on user intent in the composer. Only the existing `ensurePDFTextCached` path was retained because this fork's context and quotation services differ from upstream.

Upstream regression cases are included for these changes and exercised by the Papers CI workflow.

## Integration constraints

The fork has its own ChatGPT Web/Papers conversation, PDF, attachment and UI contracts. Broad upstream UI redesigns, agent provider routing, release/version metadata, persistent file-storage and MinerU local-process management have **not** been merged wholesale. Those areas need separate architecture review and runtime integration checks.

The new tests validate the imported logic, not the Zotero desktop application or a live ChatGPT Web session.
