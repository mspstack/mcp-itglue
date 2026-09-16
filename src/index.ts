#!/usr/bin/env node
/** CLI entry point — runs the MCP server over stdio (default) or HTTP. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig, type ServerConfig } from "./config.js";
import { loadTokenEntries } from "./auth/tokens.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { createApp } from "./http/app.js";
import { embedderFromEnv } from "./vector/embeddings.js";
import { createUploadStore } from "./uploads/index.js";

const USAGE = `${SERVER_NAME} v${SERVER_VERSION}

Usage: mcp-itglue [options]

Options:
  --transport stdio|http   Transport (default: stdio; env TRANSPORT)
  --port <n>               HTTP port (default: 3000; env PORT)
  --region us|eu|au        IT Glue region (default: us; env ITGLUE_REGION)
  --base-url <url>         Override the API base URL (env ITGLUE_BASE_URL)
  --help                   Show this help

Environment:
  ITGLUE_API_KEY           Server-wide IT Glue API key
  MCP_TOKENS_VIEWER        label:token[,label:token…] — read-only access (HTTP)
  MCP_TOKENS_EDITOR        label:token[,…] — read + create/update/publish
  MCP_TOKENS_ADMIN         label:token[,…] — everything incl. deletes
  CLIENT_ITGLUE_KEYS       disabled|with-token|open — client-supplied IT Glue keys (default: with-token)
  ALLOWED_ORIGINS          Extra browser origins allowed on /mcp (localhost always allowed)
  ITGLUE_WEBHOOK_SECRET    Secret for /webhook/itglue signatures and /index/refresh
  UPLOAD_STAGING           off|memory|azure-blob — staged file uploads for upload_id (default: memory on http)
  PUBLIC_BASE_URL          Reachable base URL for memory-mode upload URLs (default: http://localhost:PORT)
  AZURE_STORAGE_CONNECTION_STRING | AZURE_STORAGE_ACCOUNT [+ AZURE_STORAGE_CONTAINER]
                           azure-blob staging (SAS uploads) — for servers behind a gateway
  VECTOR_INDEX_PATH        Vector index file (default: ./vector-index.json)
  OPENAI_API_KEY | AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT
                           Enables semantic vector search
  EMBEDDING_MODEL          Embedding model / Azure deployment (default: text-embedding-3-small)
`;

function logStartupSummary(config: ServerConfig): void {
  const entries = loadTokenEntries();
  if (entries.length === 0) {
    console.error(
      "[auth] WARNING: no MCP_TOKENS_* configured — all HTTP requests are accepted with FULL admin access. " +
        "Set MCP_TOKENS_VIEWER / MCP_TOKENS_EDITOR / MCP_TOKENS_ADMIN in production."
    );
  } else {
    const byRole = entries.map((e) => `${e.label}(${e.role})`).join(", ");
    console.error(`[auth] ${entries.length} token(s) configured: ${byRole}`);
  }
  console.error(`[auth] Client-supplied IT Glue keys: ${config.clientKeyMode}`);
  if (!config.webhookSecret) {
    console.error("[webhook] ITGLUE_WEBHOOK_SECRET not set — webhook signature checks disabled.");
  }
  console.error(
    embedderFromEnv()
      ? "[vector] Embedding provider configured — vector search tools enabled."
      : "[vector] No embedding provider — vector search tools disabled (set OPENAI_API_KEY or AZURE_OPENAI_*)."
  );
}

async function runStdio(config: ServerConfig): Promise<void> {
  // stdio is a local, single-user transport: the environment's own key and
  // full tool surface apply.
  const server = createServer(config, {
    role: "admin",
    label: "stdio",
    apiKey: config.apiKey!,
  });
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (${config.baseUrl})`);
}

async function runHttp(config: ServerConfig): Promise<void> {
  logStartupSummary(config);
  const uploads = await createUploadStore(config);
  if (!uploads) {
    console.error("[uploads] Staged uploads disabled (UPLOAD_STAGING=off) — upload_id is not accepted.");
  } else if (uploads.kind === "memory") {
    console.error(`[uploads] Staged uploads in memory; clients PUT to ${config.publicBaseUrl}/upload/:id`);
    if (config.publicBaseUrl.startsWith("http://localhost")) {
      console.error("[uploads] PUBLIC_BASE_URL is not set — upload URLs point at localhost; set it for remote clients.");
    }
  } else {
    console.error(
      `[uploads] Staged uploads via Azure Blob container "${config.azureStorage?.container}" (${config.azureStorage?.connectionString ? "account key" : "DefaultAzureCredential"}).`
    );
  }
  const app = createApp(config, { uploads });
  await new Promise<void>((resolve) => {
    app.listen(config.port, "0.0.0.0", () => resolve());
  });
  console.error(`${SERVER_NAME} v${SERVER_VERSION} listening on :${config.port} (${config.baseUrl})`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  let config: ServerConfig;
  try {
    config = loadConfig(argv);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}\n`);
      console.error(USAGE);
      process.exit(1);
    }
    throw err;
  }

  if (config.transport === "http") await runHttp(config);
  else await runStdio(config);
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
