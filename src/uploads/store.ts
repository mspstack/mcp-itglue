/**
 * Staged uploads — how a client gets a real file into a tool call without
 * pushing megabytes of base64 through the model.
 *
 * Flow: the model calls `itglue_request_upload` → gets an `upload_id` plus a
 * URL to PUT the bytes to → the client (curl, a script) PUTs the file → the
 * model calls itglue_create_document_image / itglue_create_attachment with
 * `upload_id`, and the server reads the bytes itself.
 *
 * Two backends:
 *  - memory: the PUT goes to this server's own `/upload/:id` route (same
 *    auth headers as /mcp). Fits a directly reachable deployment.
 *  - azure-blob: the PUT goes straight to Azure Blob Storage with a
 *    short-lived SAS; the server later downloads the blob with its own
 *    credentials. Fits a server that sits behind a gateway and is not
 *    reachable from the client.
 *
 * Every ticket is bound to the principal (role + label + key hash) that
 * requested it, so one client cannot consume another's upload.
 */

import { createHash, randomBytes } from "node:crypto";

export const UPLOAD_TTL_MS = 15 * 60 * 1000;
/** Cap on all bytes staged in memory at once (memory backend). */
export const MAX_STAGED_TOTAL_BYTES = 256 * 1024 * 1024;

export type UploadStoreKind = "memory" | "azure-blob";

export interface UploadTicket {
  upload_id: string;
  method: "PUT";
  url: string;
  /** Extra request headers the PUT must carry. */
  headers: Record<string, string>;
  /** "same-as-mcp": send the Authorization / x-itglue-api-key headers used for /mcp; "none": the URL is self-authorizing. */
  auth: "same-as-mcp" | "none";
  expires_at: string;
  max_bytes: number;
}

export interface StagedUpload {
  buffer: Buffer;
  fileName?: string;
}

export type ReceiveOutcome =
  | "ok"
  | "not-found"
  | "forbidden"
  | "expired"
  | "too-large"
  | "already-uploaded";

export type TakeResult =
  | { status: "ok"; upload: StagedUpload }
  /** Ticket exists but no bytes have arrived yet (memory backend can tell). */
  | { status: "pending" }
  /** Unknown, expired, consumed, or belongs to someone else — never say which. */
  | { status: "missing" };

export interface UploadStore {
  readonly kind: UploadStoreKind;
  /** Create a ticket the client can PUT a file to. */
  issue(principal: string, fileName?: string): Promise<UploadTicket>;
  /** memory backend only: accept the bytes for a ticket (called by the HTTP route). */
  receive?(principal: string, uploadId: string, bytes: Buffer, fileName?: string): Promise<ReceiveOutcome>;
  /** Consume a ticket's bytes exactly once. */
  take(principal: string, uploadId: string): Promise<TakeResult>;
}

/** What tool handlers see: the store already bound to the session's principal. */
export interface StagedSource {
  take(uploadId: string): Promise<TakeResult>;
}

export function bindUploads(store: UploadStore, principal: string): StagedSource {
  return { take: (uploadId) => store.take(principal, uploadId) };
}

/** 24 url-safe characters, 144 bits of randomness. */
export function newUploadId(): string {
  return randomBytes(18).toString("base64url");
}

export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;

/** Short, non-reversible principal prefix for namespacing blobs. */
export function principalHash(principal: string): string {
  return createHash("sha256").update(principal).digest("hex").slice(0, 16);
}
