/**
 * Builds an McpServer for one session. A session is defined by:
 *  - the IT Glue API key it uses (the server-wide key, or a client-supplied one)
 *  - the role that gates which tools are registered
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import type { Role } from "./auth/tokens.js";
import { ToolRegistrar } from "./auth/roles.js";
import { ITGlueClient } from "./itglue/client.js";
import type { ServerConfig } from "./config.js";
import { embedderFromEnv } from "./vector/embeddings.js";
import { openIndex } from "./vector/store.js";
import type { IndexerDeps } from "./vector/indexer.js";
import { registerOrganizationTools } from "./tools/organizations.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerDocumentSectionTools } from "./tools/document-sections.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerDocumentImageTools } from "./tools/document-images.js";
import { registerFlexibleAssetTools } from "./tools/flexible-assets.js";
import { registerVectorSearchTools } from "./tools/vector-search.js";
import { registerAdvancedTools } from "./tools/advanced.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const SERVER_NAME = pkg.name;
export const SERVER_VERSION = pkg.version;

export interface SessionIdentity {
  role: Role;
  label: string;
  apiKey: string;
}

const INSTRUCTIONS = `# IT Glue MCP server

## Finding things
- Filters use EXACT matching except name filters (partial). When unsure of a name, list without filters and scan.
- Typical flow: itglue_list_organizations → itglue_list_documents → itglue_get_document (→ itglue_get_document_section for long docs).
- Prefer itglue_vector_search (if available) for "how do I…" questions — it matches meaning, not words.
- If itglue_find_endpoint / itglue_get are available, use them for API surface the curated tools don't cover — prefer the curated tool when one exists.

## Writing documents
1. itglue_create_document creates a DRAFT (invisible until published).
2. Add content with itglue_create_document_section (Text/Heading/Gallery/Step; content is HTML).
3. itglue_publish_document makes it visible.
- itglue_update_document only renames; content changes go through sections.

## Flexible assets
- Get the type's field list with itglue_get_flexible_asset_type before creating/updating.
- Updates REPLACE the whole traits object — send all traits back.

## Attachments & images
- Attach an image/file to any record (document, flexible asset, configuration, …) with itglue_create_attachment — pass content_base64, a url, or a local file_path (stdio only) plus a file_name.
- For images inside a document's body, put <img src="…"> HTML in a Text section (itglue_create_document_section).

## Notes
- Delete operations are permanent.
- Some tools may be unavailable depending on this session's access level.`;

/** Build the indexer dependency bundle for a session, or null when vector search is disabled. */
export function indexerDepsFor(
  config: ServerConfig,
  client: ITGlueClient
): IndexerDeps | null {
  const embedder = embedderFromEnv();
  if (!embedder) return null;
  return { client, embedder, index: openIndex(config.vectorIndexPath) };
}

export function createServer(config: ServerConfig, session: SessionIdentity): McpServer {
  const client = new ITGlueClient({ apiKey: session.apiKey, baseUrl: config.baseUrl });
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );

  const reg = new ToolRegistrar(server, session.role);
  const vectorDeps = indexerDepsFor(config, client);

  registerOrganizationTools(reg, client);
  registerDocumentTools(reg, client, vectorDeps);
  registerDocumentSectionTools(reg, client, vectorDeps);
  registerDocumentImageTools(reg, client, config.transport, vectorDeps);
  registerAttachmentTools(reg, client, config.transport);
  registerFlexibleAssetTools(reg, client);
  if (vectorDeps) {
    registerVectorSearchTools(reg, vectorDeps);
  }
  if (config.advancedToolset) {
    registerAdvancedTools(reg, client);
  }

  return server;
}
