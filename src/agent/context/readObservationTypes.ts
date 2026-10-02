/** What the host records about a read: the sources a verified read
 * covered and the observation it issued. Shared by read recording,
 * documents, and the MCP server. */
export type VerifiedReadSource = Readonly<{
  libraryID: number;
  itemKey: string;
  attachmentItemKey?: string;
  pageIndex?: number;
  sourceFingerprint?: string;
}>;

export type ReadObservationCapability =
  | "metadata"
  | "abstract"
  | "body"
  | "figure"
  | "quote";

export type TrustedReadObservation = Readonly<{
  version: 1;
  observationId: string;
  issuer: "zotero_host";
  toolName: string;
  callDigest: string;
  inputDigest: string;
  resultDigest: string;
  libraryID: number;
  itemKey: string;
  capabilities: readonly ReadObservationCapability[];
  attachmentItemKey?: string;
  pageIndex?: number;
  sourceFingerprint?: string;
  /** The paper_read mode that issued this observation (overview, targeted, full, ...). */
  readMode?: string;
  quoteCertificate?: string;
  certificateDigest: string;
}>;
