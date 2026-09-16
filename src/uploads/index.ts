/** Pick and construct the staging backend from configuration. */

import type { ServerConfig } from "../config.js";
import { AzureBlobUploadStore, createAzureBlobBackend } from "./azure-blob.js";
import { MemoryUploadStore } from "./memory.js";
import type { UploadStore } from "./store.js";

export type { StagedSource, UploadStore, UploadTicket } from "./store.js";
export { bindUploads } from "./store.js";

export async function createUploadStore(config: ServerConfig): Promise<UploadStore | null> {
  switch (config.uploadStaging) {
    case "off":
      return null;
    case "memory":
      return new MemoryUploadStore(config.publicBaseUrl);
    case "azure-blob": {
      if (!config.azureStorage) {
        throw new Error("UPLOAD_STAGING=azure-blob needs AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT");
      }
      return new AzureBlobUploadStore(await createAzureBlobBackend(config.azureStorage));
    }
  }
}
