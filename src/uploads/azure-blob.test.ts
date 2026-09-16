import { describe, expect, it, vi } from "vitest";
import { AzureBlobUploadStore, blobName, type BlobBackend } from "./azure-blob.js";
import { principalHash, UPLOAD_ID_PATTERN } from "./store.js";

const P1 = "editor|alice|";
const P2 = "editor|bob|";

function fakeBackend() {
  const blobs = new Map<string, { buffer: Buffer; metadata: Record<string, string> }>();
  const backend: BlobBackend = {
    uploadUrl: vi.fn(async (name: string, expiresOn: Date) => `https://acct.blob.core.windows.net/c/${name}?sig=x&se=${expiresOn.toISOString()}`),
    download: vi.fn(async (name: string) => blobs.get(name) ?? null),
    delete: vi.fn(async (name: string) => {
      blobs.delete(name);
    }),
    sweep: vi.fn(async () => {}),
  };
  return { backend, blobs };
}

describe("AzureBlobUploadStore", () => {
  it("issues a self-authorizing SAS ticket namespaced by principal", async () => {
    const { backend } = fakeBackend();
    const store = new AzureBlobUploadStore(backend);
    const ticket = await store.issue(P1, "Схема сети.png");

    expect(ticket.upload_id).toMatch(UPLOAD_ID_PATTERN);
    expect(ticket.auth).toBe("none");
    expect(ticket.url).toContain(`/${principalHash(P1)}/${ticket.upload_id}?`);
    expect(ticket.headers["x-ms-blob-type"]).toBe("BlockBlob");
    // Non-ASCII file names survive as percent-encoded metadata.
    expect(ticket.headers["x-ms-meta-filename"]).toBe(encodeURIComponent("Схема сети.png"));
    expect(backend.uploadUrl).toHaveBeenCalledWith(blobName(P1, ticket.upload_id), expect.any(Date));
  });

  it("take downloads the blob, restores the file name, and deletes it", async () => {
    const { backend, blobs } = fakeBackend();
    const store = new AzureBlobUploadStore(backend);
    const ticket = await store.issue(P1, "diagram.png");
    blobs.set(blobName(P1, ticket.upload_id), {
      buffer: Buffer.from("png-bytes"),
      metadata: { filename: encodeURIComponent("diagram.png") },
    });

    const taken = await store.take(P1, ticket.upload_id);
    expect(taken.status).toBe("ok");
    if (taken.status === "ok") {
      expect(taken.upload.buffer.toString()).toBe("png-bytes");
      expect(taken.upload.fileName).toBe("diagram.png");
    }
    expect(backend.delete).toHaveBeenCalledWith(blobName(P1, ticket.upload_id));
    expect(await store.take(P1, ticket.upload_id)).toEqual({ status: "missing" });
  });

  it("another principal looks in a different folder and finds nothing", async () => {
    const { backend, blobs } = fakeBackend();
    const store = new AzureBlobUploadStore(backend);
    const ticket = await store.issue(P1);
    blobs.set(blobName(P1, ticket.upload_id), { buffer: Buffer.from("x"), metadata: {} });

    expect(await store.take(P2, ticket.upload_id)).toEqual({ status: "missing" });
    expect(blobs.size).toBe(1);
  });

  it("rejects malformed ids without touching storage", async () => {
    const { backend } = fakeBackend();
    const store = new AzureBlobUploadStore(backend);
    expect(await store.take(P1, "../../etc/passwd")).toEqual({ status: "missing" });
    expect(backend.download).not.toHaveBeenCalled();
  });

  it("sweeps orphaned blobs at most every ten minutes", async () => {
    const { backend } = fakeBackend();
    let now = 1_000_000;
    const store = new AzureBlobUploadStore(backend, () => now);
    const id = (await store.issue(P1)).upload_id;
    await store.take(P1, id);
    await store.take(P1, id);
    expect(backend.sweep).toHaveBeenCalledTimes(1);
    now += 11 * 60 * 1000;
    await store.take(P1, id);
    expect(backend.sweep).toHaveBeenCalledTimes(2);
  });
});
