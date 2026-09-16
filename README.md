# mcp-itglue

[![npm version](https://img.shields.io/npm/v/mcp-itglue)](https://www.npmjs.com/package/mcp-itglue)
[![license: MIT](https://img.shields.io/npm/l/mcp-itglue)](LICENSE)

An MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server for the [IT Glue](https://www.itglue.com/) API, built for MSPs that want AI assistants to read — and safely write — their documentation.

- **Documents & sections** — list, read, create, update, publish, delete
- **Flexible assets** — browse asset types and their fields, list/read/create/update/delete assets
- **Images inside documents** — upload a picture into a document (inline in a Text/Step section, or into a Gallery) from base64, a URL, or a local path, and embed it with the returned `<img src>`; get and delete document images
- **Attachments** — attach any file to a record's Attachments panel (documents, flexible assets, configurations, …); list and delete attachments
- **Semantic vector search** — "how do I remove a backup agent" finds the Veeam decommissioning runbook, even when the words don't match (OpenAI or Azure OpenAI embeddings, local JSON index)
- **Role-based access control** — viewer / editor / admin bearer tokens decide which tools each session can even see
- **Bring your own key** — clients may supply their own IT Glue API key per session, so IT Glue's own permissions apply
- **Index freshness** — IT Glue webhook, post-write self-refresh, and a manual refresh endpoint
- **Transports** — stdio for local use, streamable HTTP for shared deployments; Docker image included

## Installation

You need an IT Glue API key (IT Glue → Account → Settings → API Keys). Non-US accounts set `ITGLUE_REGION` to `eu` or `au`.

### npx (recommended)

Claude Desktop (`claude_desktop_config.json`) or Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "itglue": {
      "command": "npx",
      "args": ["-y", "mcp-itglue"],
      "env": { "ITGLUE_API_KEY": "ITG.xxxx" }
    }
  }
}
```

Claude Code one-liner:

```bash
claude mcp add itglue --env ITGLUE_API_KEY=ITG.xxxx -- npx -y mcp-itglue
```

Claude Desktop users can instead grab `mcp-itglue.mcpb` from the [latest release](https://github.com/mspstack/mcp-itglue/releases/latest) — open it with Claude Desktop and fill in the API key when prompted.

stdio always runs with the full tool surface — it is a local, single-user transport using your own key.

### Docker

The container image defaults to the HTTP transport (for [shared deployments](#http-deployment)):

```bash
docker run --rm -p 3000:3000 \
  -e ITGLUE_API_KEY=ITG.xxxx \
  ghcr.io/mspstack/mcp-itglue
```

For local stdio use under Docker:

```json
{
  "mcpServers": {
    "itglue": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "ITGLUE_API_KEY", "ghcr.io/mspstack/mcp-itglue", "--transport", "stdio"],
      "env": { "ITGLUE_API_KEY": "ITG.xxxx" }
    }
  }
}
```

### From source

```bash
git clone https://github.com/mspstack/mcp-itglue.git && cd mcp-itglue
npm install && npm run build
ITGLUE_API_KEY=ITG.xxxx node dist/index.js
```

## HTTP deployment

```bash
ITGLUE_API_KEY=ITG.xxxx \
MCP_TOKENS_VIEWER="alice:$(openssl rand -hex 32)" \
MCP_TOKENS_EDITOR="automation:$(openssl rand -hex 32)" \
MCP_TOKENS_ADMIN="ops:$(openssl rand -hex 32)" \
npx -y mcp-itglue --transport http --port 3000
```

Or with Docker:

```bash
docker run --rm -p 3000:3000 \
  -e ITGLUE_API_KEY -e MCP_TOKENS_VIEWER -e MCP_TOKENS_EDITOR -e MCP_TOKENS_ADMIN \
  ghcr.io/mspstack/mcp-itglue
```

Endpoints:

| Route | Purpose |
|---|---|
| `POST/GET/DELETE /mcp` | MCP streamable-http endpoint |
| `GET /health` | Liveness probe |
| `POST /webhook/itglue` | IT Glue webhook → incremental index update |
| `POST /index/refresh` | Manual index refresh (shared secret or admin token) |
| `PUT /upload/:id` | Staged file upload slot (memory backend; same auth as `/mcp`) |

> Sessions are held in memory — run a single instance (or add sticky sessions) behind your load balancer.

## Access control

### Role tokens

Three env vars hold comma-separated `label:token` lists:

```bash
MCP_TOKENS_VIEWER="alice:tokA,bob:tokB"   # read-only tools
MCP_TOKENS_EDITOR="hatz:tokC"             # + create/update/publish, delete section
MCP_TOKENS_ADMIN="ops:tokD"               # + delete documents / flexible assets
```

Clients authenticate with `Authorization: Bearer <token>`. The label appears in the audit log (`[rbac] session … for alice (viewer)`) and lets you revoke one person's token without rotating everyone's.

Tools a role cannot use are **not registered** for that session — a viewer doesn't even see `itglue_create_document` in `tools/list` — and a runtime guard re-checks the role on every call as defense in depth. Session ids never carry privilege: every request re-authenticates, and presenting a different principal against an existing session returns 403.

If **no** tokens are configured, the server runs in dev mode: all requests get admin access and a loud startup warning. Don't do this in production.

### Bring your own IT Glue key (BYOK)

Clients may send their own IT Glue API key in the `x-itglue-api-key` header on the initialize request. The session then talks to IT Glue with **that** key and gets the full tool surface — IT Glue's own key permissions are the effective access control. `CLIENT_ITGLUE_KEYS` controls the policy:

| Value | Behavior |
|---|---|
| `with-token` (default) | BYOK allowed, but a valid bearer token is still required — protects your server from being an open proxy |
| `open` | An IT Glue key alone authenticates (trusted networks / local use) |
| `disabled` | The header is rejected; only the server-wide key is used |

With BYOK enabled the server-wide `ITGLUE_API_KEY` becomes optional: sessions without a client key are rejected with a clear error. Client keys are never logged; sessions are bound to a SHA-256 hash of the key and audit-labeled `byok:<hash-prefix>`.

## Tools

| Tool | Tier |
|---|---|
| `itglue_list_organizations`, `itglue_get_organization` | read |
| `itglue_list_documents`, `itglue_get_document` | read |
| `itglue_list_document_folders` | read |
| `itglue_list_document_sections`, `itglue_get_document_section` | read |
| `itglue_list_flexible_asset_types`, `itglue_get_flexible_asset_type` | read |
| `itglue_list_flexible_assets`, `itglue_get_flexible_asset` | read |
| `itglue_get_document_image` | read |
| `itglue_list_attachments` | read |
| `itglue_vector_search`, `itglue_vector_index_status` | read |
| `itglue_create_document`, `itglue_update_document`, `itglue_publish_document` | write |
| `itglue_create_document_section`, `itglue_update_document_section` | write |
| `itglue_delete_document_section` † | write |
| `itglue_create_document_image` | write |
| `itglue_delete_document_image` † | write |
| `itglue_request_upload` (HTTP, when `UPLOAD_STAGING` ≠ off) | write |
| `itglue_create_flexible_asset`, `itglue_update_flexible_asset` | write |
| `itglue_create_attachment` | write |
| `itglue_build_vector_index` | write |
| `itglue_delete_documents` | destructive |
| `itglue_delete_flexible_asset` | destructive |
| `itglue_delete_attachment` | destructive |
| `itglue_find_endpoint`, `itglue_get` ‡ | read |

Viewer = read. Editor = read + write. Admin = everything.
† Permanent, but editor-tier: editors need these to restructure documents and can already blank section content (or edit an `<img>` out of it) via update.

### Images in documents vs. attachments

IT Glue has two unrelated upload paths. **Attachments** (`itglue_create_attachment`) land in a record's Attachments side panel and never render in a document's body. To show a picture *inside* a document, use `itglue_create_document_image`:

1. Upload with `document_id` (inline) or `document_id` + `gallery_id` (the `document_gallery_id` of a Gallery/Step section).
2. For inline images, put the returned `inline_resource_url` verbatim into the section HTML: `<img src="/6255696/docs/17772862/images/27211966">` — or pass `append_to_section_id` and the tool appends it to an existing Text/Step section for you.

IT Glue strips `data:` URIs and its own S3 URLs from section content; only these relative paths (and public `https://` links) survive.

### Getting a file from the client to the server (staged uploads)

Tool arguments travel through the model, so `content_base64` only works for tiny files — a screenshot is megabytes of base64 the model would have to reproduce token by token (and IT Glue rejects the truncated result with `NotIdentifiedByImageMagickError`). Over HTTP the server therefore offers **staged uploads**:

1. The model calls `itglue_request_upload` (`file_name` optional) and gets an `upload_id`, a URL, and a ready-to-run `curl`.
2. The client PUTs the file to that URL from a shell.
3. The model calls `itglue_create_document_image` or `itglue_create_attachment` with `upload_id`.

Slots live 15 minutes, are bound to the requesting principal (token label / BYOK key), and are consumed once. Two backends, chosen with `UPLOAD_STAGING`:

| Mode | Where the PUT goes | When to use |
|---|---|---|
| `memory` (default on HTTP) | This server's `PUT /upload/:id`, with the same `Authorization` / `x-itglue-api-key` headers as `/mcp`. Set `PUBLIC_BASE_URL` so the URL is reachable. | The server is directly reachable by clients. |
| `azure-blob` | A short-lived SAS URL on Azure Blob Storage; the server later downloads the blob with its own credentials and deletes it. | The server sits behind a gateway or is otherwise not reachable from clients. Configure `AZURE_STORAGE_CONNECTION_STRING` (account-key SAS) **or** `AZURE_STORAGE_ACCOUNT` (managed identity / `az login` via `DefaultAzureCredential`, needs *Storage Blob Data Contributor* + *Storage Blob Delegator*), plus optional `AZURE_STORAGE_CONTAINER` (default `mcp-itglue-uploads`). |
| `off` | — | stdio (default there — `file_path` reads the local disk directly) or when you don't want the feature. |

`url` remains the simplest source for anything already hosted on the web.
‡ Advanced toolset (opt-in, off by default): `itglue_get` is a read-only GET passthrough for any API path the curated tools don't wrap, and `itglue_find_endpoint` searches a curated endpoint catalog. Enable with `ITGLUE_ADVANCED_TOOLSET=true` or `--advanced`. Password resources (`/passwords`) are hard-blocked — credential values never reach the model.

Vector tools appear only when an embedding provider is configured.

## Vector search

Set `OPENAI_API_KEY` (or `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`, where `EMBEDDING_MODEL` is your deployment name), then run `itglue_build_vector_index` per organization. The index is a JSON file at `VECTOR_INDEX_PATH` (default `./vector-index.json`) — on ephemeral hosts, point it at a persistent volume.

The index stays fresh three ways:

1. **IT Glue webhook** — in IT Glue, webhooks are sent by **Workflows** (Admin → Workflows): add a *Document* trigger (created/updated) with a *Webhook* action. Workflow actions cannot send custom headers, so put the shared secret in the URL:

   ```
   https://<host>/webhook/itglue?secret=<ITGLUE_WEBHOOK_SECRET>
   ```

   and use a JSON payload template like:

   | Key | Value |
   |---|---|
   | `event` | `[trigger_name]` |
   | `resource_url` | `[resource_url]` |
   | `resource_name` | `[resource_name]` |
   | `organization_name` | `[organization_name]` |

   The document id is parsed from `resource_url`; the trigger name maps to created/updated/deleted by keyword. Classic JSON:API-style payloads with an `x-itglue-webhook-signature` HMAC-SHA256 header are also accepted.
2. **Self-refresh** — documents created/updated/published/deleted through this server's tools are re-indexed automatically in the background.
3. **Manual refresh** — `POST /index/refresh` with `Authorization: Bearer <ITGLUE_WEBHOOK_SECRET>` (or an `x-refresh-secret` header, or an admin token). Body `{"document_id": "123"}` refreshes one document; an empty body re-crawls every indexed organization. Returns `202` and processes in the background.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `ITGLUE_API_KEY` | — | Server-wide IT Glue API key |
| `ITGLUE_REGION` | `us` | `us`, `eu`, or `au` |
| `ITGLUE_BASE_URL` | per region | Override the API base URL |
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3000` | HTTP port |
| `MCP_TOKENS_VIEWER/EDITOR/ADMIN` | — | `label:token,label:token` per role |
| `CLIENT_ITGLUE_KEYS` | `with-token` | BYOK policy: `disabled`, `with-token`, `open` |
| `ALLOWED_ORIGINS` | — | Extra browser origins allowed on `/mcp` (comma-separated). Requests without an `Origin` header and localhost origins always pass; other browser origins are rejected with 403 |
| `ITGLUE_ADVANCED_TOOLSET` | `false` | `true`/`1` registers the advanced toolset (`itglue_get`, `itglue_find_endpoint`) |
| `ITGLUE_WEBHOOK_SECRET` | — | Webhook signature + `/index/refresh` secret |
| `VECTOR_INDEX_PATH` | `./vector-index.json` | Vector index file |
| `OPENAI_API_KEY` | — | Enables vector search (OpenAI) |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_VERSION` | — | Enables vector search (Azure OpenAI) |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model / Azure deployment |

CLI flags `--transport`, `--port`, `--region`, `--base-url`, `--advanced` override the environment. Run `mcp-itglue --help` for details.

## Notes & limits

- IT Glue rate limit: 3000 requests / 5 minutes per key.
- The IT Glue documents API is only partially documented; document/section endpoints follow observed API behavior.
- Flexible-asset trait updates replace the whole traits object — the update tool's description warns the model to send all traits back.
- List tools return summary fields per item (in both text and `structuredContent`) so default page sizes stay within client token limits; the `itglue_get_*` tools return the complete record.
- IT Glue has no user impersonation: a given API key always acts as itself. RBAC here controls what *tool calls* a session may make; BYOK delegates to IT Glue's own key permissions.

## Development

```bash
npm install
npm run dev          # stdio via tsx
npm run dev:http     # http via tsx
npm test             # vitest
npm run build        # tsc → dist/
```

## Author

Built by **Eugene Samotija** ([@selic](https://github.com/selic)) — [defency.net](https://defency.net).
More projects: [github.com/selic](https://github.com/selic) · [LinkedIn](https://www.linkedin.com/in/evghenii-samotiia)

## License

[MIT](LICENSE)
