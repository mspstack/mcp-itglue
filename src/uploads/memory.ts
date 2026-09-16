/**
 * In-process staging: tickets and bytes live in a Map for UPLOAD_TTL_MS. The
 * PUT arrives on this server's `/upload/:id` route, so the deployment must be
 * reachable by the client. State is per process — fine for a single-instance
 * App Service or a local run, not for a scaled-out fleet.
 */

import { MAX_UPLOAD_BYTES } from "../tools/binary-input.js";
import {
  MAX_STAGED_TOTAL_BYTES,
  newUploadId,
  UPLOAD_TTL_MS,
  type ReceiveOutcome,
  type StagedUpload,
  type TakeResult,
  type UploadStore,
  type UploadTicket,
} from "./store.js";

interface Record_ {
  principal: string;
  fileName?: string;
  expiresAt: number;
  buffer?: Buffer;
}

export class MemoryUploadStore implements UploadStore {
  readonly kind = "memory" as const;
  private readonly records = new Map<string, Record_>();

  constructor(
    private readonly publicBaseUrl: string,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = MAX_UPLOAD_BYTES,
    private readonly maxTotalBytes = MAX_STAGED_TOTAL_BYTES
  ) {}

  /** Ticket URL for an id — exported shape so the HTTP route and tests agree. */
  uploadUrl(uploadId: string): string {
    return `${this.publicBaseUrl.replace(/\/+$/, "")}/upload/${uploadId}`;
  }

  async issue(principal: string, fileName?: string): Promise<UploadTicket> {
    this.sweep();
    const uploadId = newUploadId();
    const expiresAt = this.now() + UPLOAD_TTL_MS;
    this.records.set(uploadId, { principal, fileName, expiresAt });
    return {
      upload_id: uploadId,
      method: "PUT",
      url: this.uploadUrl(uploadId),
      headers: { "Content-Type": "application/octet-stream" },
      auth: "same-as-mcp",
      expires_at: new Date(expiresAt).toISOString(),
      max_bytes: this.maxBytes,
    };
  }

  async receive(
    principal: string,
    uploadId: string,
    bytes: Buffer,
    fileName?: string
  ): Promise<ReceiveOutcome> {
    this.sweep();
    const rec = this.records.get(uploadId);
    if (!rec) return "not-found";
    if (rec.principal !== principal) return "forbidden";
    if (rec.expiresAt <= this.now()) {
      this.records.delete(uploadId);
      return "expired";
    }
    if (rec.buffer) return "already-uploaded";
    if (bytes.length > this.maxBytes || this.stagedBytes() + bytes.length > this.maxTotalBytes) {
      return "too-large";
    }
    rec.buffer = bytes;
    if (fileName) rec.fileName = fileName;
    return "ok";
  }

  async take(principal: string, uploadId: string): Promise<TakeResult> {
    this.sweep();
    const rec = this.records.get(uploadId);
    if (!rec || rec.principal !== principal) return { status: "missing" };
    if (!rec.buffer) return { status: "pending" };
    this.records.delete(uploadId);
    const upload: StagedUpload = { buffer: rec.buffer, fileName: rec.fileName };
    return { status: "ok", upload };
  }

  /** Number of live tickets (tests / diagnostics). */
  get size(): number {
    this.sweep();
    return this.records.size;
  }

  private stagedBytes(): number {
    let total = 0;
    for (const rec of this.records.values()) total += rec.buffer?.length ?? 0;
    return total;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, rec] of this.records) {
      if (rec.expiresAt <= now) this.records.delete(id);
    }
  }
}
