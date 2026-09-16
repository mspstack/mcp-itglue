/**
 * Server configuration, resolved from CLI flags and environment variables.
 *
 * Environment variables:
 *   ITGLUE_API_KEY        Server-wide IT Glue API key (optional when client keys are enabled)
 *   ITGLUE_REGION         us | eu | au (default: us)
 *   ITGLUE_BASE_URL       Full API base URL (overrides ITGLUE_REGION)
 *   TRANSPORT             stdio | http (default: stdio)
 *   PORT                  HTTP port (default: 3000)
 *   CLIENT_ITGLUE_KEYS    disabled | with-token | open (default: with-token)
 *                         Controls whether HTTP clients may supply their own
 *                         IT Glue API key via the x-itglue-api-key header.
 *   MCP_TOKENS_VIEWER     Comma-separated label:token list for the viewer role
 *   MCP_TOKENS_EDITOR     Comma-separated label:token list for the editor role
 *   MCP_TOKENS_ADMIN      Comma-separated label:token list for the admin role
 *   ALLOWED_ORIGINS       Comma-separated browser origins additionally allowed on
 *                         /mcp (e.g. https://app.example.com). Localhost origins
 *                         and requests without an Origin header always pass.
 *   ITGLUE_ADVANCED_TOOLSET
 *                         true|1 registers the advanced toolset (itglue_get /
 *                         itglue_find_endpoint) — also via the --advanced flag.
 *                         Off by default; the tools are an escape hatch for
 *                         API surface the curated tools don't wrap.
 *   UPLOAD_STAGING        off | memory | azure-blob — how clients hand real files to
 *                         itglue_create_document_image / itglue_create_attachment
 *                         without pushing base64 through the model (default:
 *                         memory on http, off on stdio where file_path works).
 *                         memory: clients PUT to this server's /upload/:id.
 *                         azure-blob: clients PUT to a short-lived SAS URL.
 *   PUBLIC_BASE_URL       Externally reachable base URL of this server, used to
 *                         build memory-mode upload URLs (default: http://localhost:PORT)
 *   AZURE_STORAGE_CONNECTION_STRING
 *                         azure-blob staging with an account key (SAS signed locally)
 *   AZURE_STORAGE_ACCOUNT azure-blob staging via DefaultAzureCredential (managed
 *                         identity / az login) — user-delegation SAS
 *   AZURE_STORAGE_CONTAINER
 *                         Blob container for staged uploads (default: mcp-itglue-uploads)
 *   ITGLUE_WEBHOOK_SECRET Shared secret for /webhook/itglue (HMAC) and /index/refresh
 *   VECTOR_INDEX_PATH     Path of the persisted vector index (default: ./vector-index.json)
 *   OPENAI_API_KEY        Enables vector search (OpenAI embeddings)
 *   AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT
 *                         Enables vector search via Azure OpenAI (takes priority)
 *   EMBEDDING_MODEL       Embedding model or Azure deployment name
 *                         (default: text-embedding-3-small)
 */

export const REGION_BASE_URLS: Record<string, string> = {
  us: "https://api.itglue.com",
  eu: "https://api.eu.itglue.com",
  au: "https://api.au.itglue.com",
};

export type Transport = "stdio" | "http";
export type ClientKeyMode = "disabled" | "with-token" | "open";

const CLIENT_KEY_MODES: ClientKeyMode[] = ["disabled", "with-token", "open"];

export type UploadStagingMode = "off" | "memory" | "azure-blob";
const UPLOAD_STAGING_MODES: UploadStagingMode[] = ["off", "memory", "azure-blob"];

export interface AzureStorageConfig {
  account?: string;
  container: string;
  connectionString?: string;
}

export interface ServerConfig {
  transport: Transport;
  port: number;
  baseUrl: string;
  /** Server-wide IT Glue API key. May be absent when client-supplied keys are enabled. */
  apiKey: string | undefined;
  clientKeyMode: ClientKeyMode;
  /** Browser origins additionally allowed on /mcp (localhost always passes). */
  allowedOrigins: string[];
  /** Register the advanced toolset (itglue_get / itglue_find_endpoint). */
  advancedToolset: boolean;
  webhookSecret: string | undefined;
  vectorIndexPath: string;
  /** Staged-upload backend (see UPLOAD_STAGING). */
  uploadStaging: UploadStagingMode;
  /** Externally reachable base URL, for memory-mode upload tickets. */
  publicBaseUrl: string;
  /** Present when uploadStaging === "azure-blob". */
  azureStorage: AzureStorageConfig | undefined;
}

export class ConfigError extends Error {}

/**
 * Read an env var defensively: desktop/MCPB hosts pass unfilled optional
 * user_config fields as empty strings or leave the "${user_config.…}"
 * template unsubstituted — both must fall through to the default.
 */
export function cleanEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (!value || value.includes("${")) return undefined;
  return value;
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ConfigError(`Missing value for ${name}`);
  }
  return value;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): ServerConfig {
  const transport = (flagValue(argv, "--transport") || cleanEnv(env, "TRANSPORT") || "stdio") as Transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new ConfigError(`Invalid transport "${transport}" — expected "stdio" or "http"`);
  }

  const portRaw = flagValue(argv, "--port") || cleanEnv(env, "PORT") || "3000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid port "${portRaw}"`);
  }

  const region = (flagValue(argv, "--region") || cleanEnv(env, "ITGLUE_REGION") || "us").toLowerCase();
  const regionUrl = REGION_BASE_URLS[region];
  if (!regionUrl) {
    throw new ConfigError(
      `Unknown IT Glue region "${region}" — expected one of: ${Object.keys(REGION_BASE_URLS).join(", ")}`
    );
  }
  const baseUrl = flagValue(argv, "--base-url") || cleanEnv(env, "ITGLUE_BASE_URL") || regionUrl;
  let baseUrlProtocol: string;
  try {
    baseUrlProtocol = new URL(baseUrl).protocol;
  } catch {
    throw new ConfigError(`Invalid IT Glue base URL "${baseUrl}" — expected e.g. https://api.itglue.com`);
  }
  if (baseUrlProtocol !== "https:" && baseUrlProtocol !== "http:") {
    throw new ConfigError(`Invalid IT Glue base URL "${baseUrl}" — must be http(s)`);
  }

  const clientKeyMode = (cleanEnv(env, "CLIENT_ITGLUE_KEYS") || "with-token") as ClientKeyMode;
  if (!CLIENT_KEY_MODES.includes(clientKeyMode)) {
    throw new ConfigError(
      `Invalid CLIENT_ITGLUE_KEYS "${clientKeyMode}" — expected one of: ${CLIENT_KEY_MODES.join(", ")}`
    );
  }

  const apiKey = cleanEnv(env, "ITGLUE_API_KEY");

  if (transport === "stdio" && !apiKey) {
    throw new ConfigError("ITGLUE_API_KEY is required for stdio transport");
  }
  if (transport === "http" && !apiKey && clientKeyMode === "disabled") {
    throw new ConfigError(
      "ITGLUE_API_KEY is required when CLIENT_ITGLUE_KEYS=disabled — there is no key the server could use"
    );
  }

  const allowedOrigins = (cleanEnv(env, "ALLOWED_ORIGINS") || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);

  const advancedEnv = (cleanEnv(env, "ITGLUE_ADVANCED_TOOLSET") || "").toLowerCase();
  const advancedToolset = argv.includes("--advanced") || advancedEnv === "true" || advancedEnv === "1";

  const uploadStaging = (cleanEnv(env, "UPLOAD_STAGING") ||
    (transport === "http" ? "memory" : "off")) as UploadStagingMode;
  if (!UPLOAD_STAGING_MODES.includes(uploadStaging)) {
    throw new ConfigError(
      `Invalid UPLOAD_STAGING "${uploadStaging}" — expected one of: ${UPLOAD_STAGING_MODES.join(", ")}`
    );
  }
  const publicBaseUrl = (cleanEnv(env, "PUBLIC_BASE_URL") || `http://localhost:${port}`).replace(/\/+$/, "");
  try {
    new URL(publicBaseUrl);
  } catch {
    throw new ConfigError(`Invalid PUBLIC_BASE_URL "${publicBaseUrl}" — expected e.g. https://mcp.example.com`);
  }
  let azureStorage: AzureStorageConfig | undefined;
  if (uploadStaging === "azure-blob") {
    const connectionString = cleanEnv(env, "AZURE_STORAGE_CONNECTION_STRING");
    const account = cleanEnv(env, "AZURE_STORAGE_ACCOUNT");
    if (!connectionString && !account) {
      throw new ConfigError(
        "UPLOAD_STAGING=azure-blob needs AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT (+ an Azure identity)"
      );
    }
    azureStorage = {
      account,
      connectionString,
      container: cleanEnv(env, "AZURE_STORAGE_CONTAINER") || "mcp-itglue-uploads",
    };
  }

  return {
    transport,
    port,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    clientKeyMode,
    allowedOrigins,
    advancedToolset,
    webhookSecret: cleanEnv(env, "ITGLUE_WEBHOOK_SECRET"),
    vectorIndexPath: cleanEnv(env, "VECTOR_INDEX_PATH") || "./vector-index.json",
    uploadStaging,
    publicBaseUrl,
    azureStorage,
  };
}
