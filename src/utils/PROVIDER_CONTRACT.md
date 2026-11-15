# Provider request contract

Provider support covers the settings Test button and custom-setting probes, regular chat, agent turns and tool continuations, and standalone utility calls.
Each advertised protocol must satisfy the same provider requirements.

`providerTransport.ts` owns inference dispatch through `sendProviderRequest`.
It determines provider requirements from the actual destination URL and applies them immediately before calling fetch.
Adapters retain ownership of protocol payloads, response parsing, and authentication.
Do not add provider-required headers to an individual UI or adapter caller.

Every dispatch requires a `ProviderRequestScope`.
Use the existing conversation key for chat and agent turns, including retries and mode switches.
Create one operation scope for a standalone task, and reuse it across that task's probes and retries.
The public chat completion helpers create an operation scope when used without a conversation.
Conversation keys are salted and hashed before transmission; raw Zotero identifiers must not be sent.
A required session that cannot be derived causes a local error before network dispatch.

Protocol support and file-upload support are separate capabilities.
Adding Responses API support must not implicitly enable `/files` uploads.

`test/providerRequestContract.test.ts` exercises outgoing requests through each product entry point and every protocol advertised by the OpenCode preset.
It covers streaming, tool continuations, conversation isolation, mode switching, and retry stability.
`test/providerRequestBoundary.test.ts` checks destination isolation and verifies that the lint rules reject direct inference HTTP calls.
`test-workflows/opencodeProvider.workflow.test.ts` clicks the installed settings Test button and exercises chat and agent requests in the native Zotero host.
The native workflow uses a controlled provider response; it does not establish acceptance by the live OpenCode service.
An authenticated provider acceptance check remains a separate validation step.
