/**
 * Azure Blob staging: the client PUTs straight to Blob Storage with a
 * short-lived, single-blob SAS; the server later downloads the blob with its
 * own credentials and deletes it. The server itself never has to be reachable
 * from the client — this is the backend for a deployment behind a gateway.
 *
 * Blob names are `<principal-hash>/<upload_id>`, so `take` for another
 * principal simply looks in a different folder and finds nothing.
 *
 * The Azure SDKs are loaded lazily in `createAzureBlobBackend` so stdio and
 * memory-mode deployments never import them.
 */

import { newUploadId, principalHash, UPLOAD_ID_PATTERN, UPLOAD_TTL_MS, type TakeResult, type UploadStore, type UploadTicket } from "./store.js";
import { MAX_UPLOAD_BYTES } from "../tools/binary-input.js";

/** The slice of Blob Storage this store needs — injectable for tests. */
export interface BlobBackend {
  /** URL (with SAS) that allows creating/writing exactly `blobName` until `expiresOn`. */
  uploadUrl(blobName: string, expiresOn: Date): Promise<string>;
  /** Blob bytes + metadata, or null when it does not exist. */
  download(blobName: string): Promise<{ buffer: Buffer; metadata: Record<string, string> } | null>;
  delete(blobName: string): Promise<void>;
  /** Best-effort removal of blobs last modified before `olderThan`. */
  sweep(olderThan: Date): Promise<void>;
}

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const FILENAME_META = "filename";

export class AzureBlobUploadStore implements UploadStore {
  readonly kind = "azure-blob" as const;
  private lastSweep = 0;

  constructor(
    private readonly backend: BlobBackend,
    private readonly now: () => number = Date.now
  ) {}

  async issue(principal: string, fileName?: string): Promise<UploadTicket> {
    const uploadId = newUploadId();
    const expiresAt = this.now() + UPLOAD_TTL_MS;
    const url = await this.backend.uploadUrl(blobName(principal, uploadId), new Date(expiresAt));
    const headers: Record<string, string> = {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": "application/octet-stream",
    };
    // Metadata values must be ASCII; percent-encode so any file name survives.
    if (fileName) headers[`x-ms-meta-${FILENAME_META}`] = encodeURIComponent(fileName);
    return {
      upload_id: uploadId,
      method: "PUT",
      url,
      headers,
      auth: "none",
      expires_at: new Date(expiresAt).toISOString(),
      max_bytes: MAX_UPLOAD_BYTES,
    };
  }

  async take(principal: string, uploadId: string): Promise<TakeResult> {
    void this.maybeSweep();
    if (!UPLOAD_ID_PATTERN.test(uploadId)) return { status: "missing" };
    const name = blobName(principal, uploadId);
    const blob = await this.backend.download(name);
    if (!blob) return { status: "missing" };
    await this.backend.delete(name).catch((err) =>
      console.error(`[uploads] could not delete staged blob ${name}: ${String(err)}`)
    );
    const rawName = blob.metadata[FILENAME_META];
    let fileName: string | undefined;
    if (rawName) {
      try {
        fileName = decodeURIComponent(rawName);
      } catch {
        fileName = rawName;
      }
    }
    return { status: "ok", upload: { buffer: blob.buffer, fileName } };
  }

  private async maybeSweep(): Promise<void> {
    const now = this.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    await this.backend
      .sweep(new Date(now - ORPHAN_AGE_MS))
      .catch((err) => console.error(`[uploads] blob sweep failed: ${String(err)}`));
  }
}

export function blobName(principal: string, uploadId: string): string {
  return `${principalHash(principal)}/${uploadId}`;
}

export interface AzureBlobOptions {
  /** Storage account name — required unless a connection string is given. */
  account?: string;
  container: string;
  /** Shared-key connection string; when absent, DefaultAzureCredential (managed identity, az login, …) is used. */
  connectionString?: string;
}

/**
 * Real Blob Storage backend. With a connection string the SAS is signed with
 * the account key; otherwise a user-delegation SAS is minted through the
 * identity's OAuth token (needs Storage Blob Data Contributor + Storage Blob
 * Delegator on the container/account).
 */
export async function createAzureBlobBackend(opts: AzureBlobOptions): Promise<BlobBackend> {
  const storage = await import("@azure/storage-blob");
  const { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, StorageSharedKeyCredential } = storage;

  let service: InstanceType<typeof BlobServiceClient>;
  let sharedKey: InstanceType<typeof StorageSharedKeyCredential> | undefined;
  if (opts.connectionString) {
    service = BlobServiceClient.fromConnectionString(opts.connectionString);
    const cred = service.credential;
    if (cred instanceof StorageSharedKeyCredential) sharedKey = cred;
  } else {
    if (!opts.account) throw new Error("AZURE_STORAGE_ACCOUNT is required without a connection string");
    const { DefaultAzureCredential } = await import("@azure/identity");
    service = new BlobServiceClient(
      `https://${opts.account}.blob.core.windows.net`,
      new DefaultAzureCredential()
    );
  }
  const container = service.getContainerClient(opts.container);
  await container.createIfNotExists().catch((err) => {
    console.error(
      `[uploads] could not ensure container "${opts.container}" exists (continuing; create it manually): ${String(err)}`
    );
  });

  return {
    async uploadUrl(name, expiresOn) {
      const blob = container.getBlockBlobClient(name);
      const startsOn = new Date(Date.now() - 5 * 60 * 1000); // clock skew
      const values = {
        containerName: opts.container,
        blobName: name,
        permissions: BlobSASPermissions.parse("cw"),
        startsOn,
        expiresOn,
      };
      const sas = sharedKey
        ? generateBlobSASQueryParameters(values, sharedKey).toString()
        : generateBlobSASQueryParameters(
            values,
            await service.getUserDelegationKey(startsOn, expiresOn),
            service.accountName
          ).toString();
      return `${blob.url}?${sas}`;
    },
    async download(name) {
      const blob = container.getBlockBlobClient(name);
      try {
        const props = await blob.getProperties();
        const buffer = await blob.downloadToBuffer();
        return { buffer, metadata: props.metadata ?? {} };
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 404) return null;
        throw err;
      }
    },
    async delete(name) {
      await container.getBlockBlobClient(name).deleteIfExists();
    },
    async sweep(olderThan) {
      for await (const item of container.listBlobsFlat()) {
        const modified = item.properties.lastModified;
        if (modified && modified < olderThan) {
          await container.getBlockBlobClient(item.name).deleteIfExists();
        }
      }
    },
  };
}
