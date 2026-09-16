/**
 * HTTP transport: Express app exposing
 *
 *   POST/GET/DELETE /mcp    MCP streamable-http endpoint (auth + RBAC)
 *   GET  /health            liveness probe
 *   POST /webhook/itglue    IT Glue webhook → incremental vector-index update
 *   POST /index/refresh     manual vector-index refresh (shared-secret protected)
 *   PUT  /upload/:id        staged file upload (memory backend only; same auth as /mcp)
 *
 * Authentication model:
 *  - Role tokens (Authorization: Bearer …) map to viewer/editor/admin and gate
 *    which tools a session gets.
 *  - Bring-your-own-key: an x-itglue-api-key header binds the session to that
 *    IT Glue key with the FULL tool surface — the key's own IT Glue permissions
 *    are the access control. CLIENT_ITGLUE_KEYS controls whether a bearer
 *    token is also required ("with-token", default), not required ("open"),
 *    or the header is rejected ("disabled").
 *  - A session id never carries privilege: every request re-authenticates and
 *    must present the same principal (role + label + key) the session was
 *    created with.
 */

import { createHash, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config.js";
import { authenticateToken, loadTokenEntries, safeEquals, type Role } from "../auth/tokens.js";
import { createServer, indexerDepsFor, SERVER_NAME, SERVER_VERSION } from "../server.js";
import { ITGlueClient } from "../itglue/client.js";
import { normalizeWebhookBody, processWebhookEvent, verifyWebhookSignature } from "../webhook/handler.js";
import { openIndex } from "../vector/store.js";
import { refreshDocument, reindexAll } from "../vector/indexer.js";
import { MAX_UPLOAD_BYTES } from "../tools/binary-input.js";
import { UPLOAD_ID_PATTERN, type ReceiveOutcome, type UploadStore } from "../uploads/store.js";

export interface AppDeps {
  /** Staged-upload backend shared by all sessions (null = feature off). */
  uploads?: UploadStore | null;
}

/** Identity string that staged uploads are bound to. Exported for tests. */
export function principalFor(role: Role, label: string, keyHash: string | null): string {
  return `${role}|${label}|${keyHash ?? ""}`;
}

const RECEIVE_STATUS: Record<ReceiveOutcome, [number, string]> = {
  ok: [200, "stored"],
  "not-found": [404, "Unknown upload_id — request a slot with itglue_request_upload first."],
  forbidden: [403, "This upload slot belongs to a different principal."],
  expired: [410, "This upload slot has expired (slots live 15 minutes) — request a new one."],
  "too-large": [413, `File exceeds the ${MAX_UPLOAD_BYTES} byte limit or the server's staging capacity.`],
  "already-uploaded": [409, "A file was already stored for this upload_id — request a new slot to replace it."],
};

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  role: Role;
  label: string;
  /** SHA-256 of the client-supplied IT Glue key, or null when the server key is used. */
  keyHash: string | null;
}

type AuthOutcome =
  | { ok: true; role: Role; label: string; apiKey: string; keyHash: string | null }
  | { ok: false; status: number; code: number; message: string };

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

const unauthorized = (message: string): AuthOutcome => ({
  ok: false,
  status: 401,
  code: -32001,
  message,
});

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Resolve the principal for a request. Exported for tests. */
export function resolveAuth(req: Request, config: ServerConfig): AuthOutcome {
  const entries = loadTokenEntries();
  const token = authenticateToken(req.headers.authorization, entries);
  const clientKey = headerValue(req, "x-itglue-api-key");

  if (clientKey) {
    if (config.clientKeyMode === "disabled") {
      return unauthorized(
        "Client-supplied IT Glue API keys are disabled on this server (CLIENT_ITGLUE_KEYS=disabled)."
      );
    }
    const keyHash = sha256(clientKey);
    const byokLabel = `byok:${keyHash.slice(0, 8)}`;
    if (config.clientKeyMode === "with-token" && entries.length > 0 && !token) {
      return unauthorized(
        "A valid bearer token is required alongside x-itglue-api-key (CLIENT_ITGLUE_KEYS=with-token)."
      );
    }
    const label = token ? `${token.label}+${byokLabel}` : byokLabel;
    // BYOK sessions get the full tool surface; the supplied key's own IT Glue
    // permissions are the effective access control.
    return { ok: true, role: "admin", label, apiKey: clientKey, keyHash };
  }

  if (entries.length === 0) {
    if (!config.apiKey) {
      return unauthorized(
        "No IT Glue API key available — set ITGLUE_API_KEY on the server or send x-itglue-api-key."
      );
    }
    return { ok: true, role: "admin", label: "dev-unauthenticated", apiKey: config.apiKey, keyHash: null };
  }

  if (!token) {
    return unauthorized("Unauthorized: invalid or missing bearer token.");
  }
  if (!config.apiKey) {
    return unauthorized(
      "This server has no ITGLUE_API_KEY configured — supply your own key via the x-itglue-api-key header."
    );
  }
  return { ok: true, role: token.role, label: token.label, apiKey: config.apiKey, keyHash: null };
}

function principalMatches(session: SessionRecord, auth: Extract<AuthOutcome, { ok: true }>): boolean {
  return (
    session.role === auth.role && session.label === auth.label && session.keyHash === auth.keyHash
  );
}

/**
 * DNS-rebinding / cross-site protection for /mcp (MCP spec: servers SHOULD
 * validate Origin). Non-browser clients (Claude Desktop, npx, curl) send no
 * Origin header and always pass; browser pages only pass from localhost or an
 * explicitly allowed origin. Exported for tests.
 */
export function originAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (origin === undefined) return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false; // malformed Origin (including the literal "null") → reject
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
  return allowedOrigins.includes(origin.replace(/\/+$/, ""));
}

export function createApp(config: ServerConfig, deps: AppDeps = {}): express.Express {
  const app = express();
  const uploads = deps.uploads ?? null;
  app.use(
    express.json({
      limit: "5mb",
      type: ["application/json", "application/*+json"],
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf-8");
      },
    })
  );

  const sessions = new Map<string, SessionRecord>();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
  });

  // ── MCP endpoint ─────────────────────────────────────────────

  app.use("/mcp", (req: Request, res: Response, next) => {
    const origin = headerValue(req, "origin");
    if (!originAllowed(origin, config.allowedOrigins)) {
      return rpcError(
        res,
        403,
        -32003,
        `Forbidden: origin "${origin}" is not allowed. Add it to ALLOWED_ORIGINS to permit browser access.`
      );
    }
    next();
  });

  app.post("/mcp", (req: Request, res: Response) => {
    void (async () => {
      const auth = resolveAuth(req, config);
      if (!auth.ok) return rpcError(res, auth.status, auth.code, auth.message);

      const sessionId = headerValue(req, "mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return rpcError(res, 404, -32000, "Session not found");
        if (!principalMatches(session, auth)) {
          return rpcError(res, 403, -32003, "Forbidden: credentials do not match this session");
        }
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        return rpcError(res, 400, -32600, "Bad request: expected an initialize request");
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, {
            transport,
            role: auth.role,
            label: auth.label,
            keyHash: auth.keyHash,
          });
          console.error(`[rbac] session ${newSessionId} created for ${auth.label} (${auth.role})`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      const server = createServer(
        config,
        {
          role: auth.role,
          label: auth.label,
          apiKey: auth.apiKey,
          principal: principalFor(auth.role, auth.label, auth.keyHash),
        },
        { uploads }
      );
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    })().catch((err) => {
      console.error(`[http] POST /mcp failed: ${String(err)}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    });
  });

  const handleSessionRequest = (req: Request, res: Response): void => {
    void (async () => {
      const auth = resolveAuth(req, config);
      if (!auth.ok) return rpcError(res, auth.status, auth.code, auth.message);

      const sessionId = headerValue(req, "mcp-session-id");
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) return rpcError(res, 404, -32000, "Session not found");
      if (!principalMatches(session, auth)) {
        return rpcError(res, 403, -32003, "Forbidden: credentials do not match this session");
      }
      await session.transport.handleRequest(req, res);
    })().catch((err) => {
      console.error(`[http] ${req.method} /mcp failed: ${String(err)}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    });
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  // ── Staged uploads (memory backend) ──────────────────────────
  // The client PUTs raw bytes to the URL from itglue_request_upload, with the
  // same credentials it uses for /mcp. The slot must belong to that principal.

  if (uploads?.kind === "memory" && uploads.receive) {
    const receive = uploads.receive.bind(uploads);
    app.put(
      "/upload/:id",
      express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES + 4096 }),
      (req: Request, res: Response) => {
        void (async () => {
          const auth = resolveAuth(req, config);
          if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
          const id = String(req.params.id ?? "");
          if (!UPLOAD_ID_PATTERN.test(id)) return res.status(404).json({ error: RECEIVE_STATUS["not-found"][1] });
          const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
          if (body.length === 0) return res.status(400).json({ error: "Empty body — send the file bytes as the request body." });
          const fileName = headerValue(req, "x-file-name");
          const outcome = await receive(principalFor(auth.role, auth.label, auth.keyHash), id, body, fileName);
          const [status, message] = RECEIVE_STATUS[outcome];
          if (outcome === "ok") {
            console.error(`[uploads] ${auth.label} staged ${body.length} bytes as ${id}`);
            return res.status(status).json({ upload_id: id, bytes: body.length, status: message });
          }
          res.status(status).json({ error: message });
        })().catch((err) => {
          console.error(`[http] PUT /upload failed: ${String(err)}`);
          if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
        });
      }
    );
    // express.raw rejects oversized bodies before the handler runs — answer in JSON.
    app.use("/upload", (err: { type?: string; status?: number }, _req: Request, res: Response, next: express.NextFunction) => {
      if (err?.type === "entity.too.large") {
        return res.status(413).json({ error: RECEIVE_STATUS["too-large"][1] });
      }
      next(err);
    });
  }

  // ── Vector-index freshness endpoints ─────────────────────────
  // Both use the server-wide IT Glue key; client keys never flow here.

  const serverIndexerDeps = () => {
    if (!config.apiKey) return null;
    const client = new ITGlueClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    return indexerDepsFor(config, client);
  };

  app.post("/webhook/itglue", (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? "";
    if (config.webhookSecret) {
      // Two auth options: HMAC signature header, or — for IT Glue Workflows,
      // which cannot send custom headers — the shared secret as ?secret=.
      const signature = headerValue(req, "x-itglue-webhook-signature");
      const querySecret = typeof req.query.secret === "string" ? req.query.secret : undefined;
      const signatureOk =
        !!signature && verifyWebhookSignature(rawBody, signature, config.webhookSecret);
      const queryOk = !!querySecret && safeEquals(querySecret, config.webhookSecret);
      if (!signatureOk && !queryOk) {
        res.status(401).json({ error: "Invalid webhook signature or secret" });
        return;
      }
    } else {
      console.error(
        "[webhook] ITGLUE_WEBHOOK_SECRET is not set — webhook authentication skipped. Set it in production."
      );
    }

    const payload = normalizeWebhookBody(req.body);
    if (!payload) {
      res.status(400).json({
        error:
          "Unrecognized payload — expected {event, data.id} or a workflow template containing a document URL",
      });
      return;
    }

    // Acknowledge immediately so IT Glue does not retry; process in the background.
    res.status(200).json({ received: true, event: payload.event, document_id: payload.data.id });

    const deps = serverIndexerDeps();
    processWebhookEvent(payload, deps, openIndex(config.vectorIndexPath))
      .then((outcome) =>
        console.error(`[webhook] ${outcome.event} (doc ${outcome.document_id}): ${outcome.action} — ${outcome.message}`)
      )
      .catch((err) => console.error(`[webhook] Unhandled error: ${String(err)}`));
  });

  app.post("/index/refresh", (req: Request, res: Response) => {
    const bearer = headerValue(req, "authorization");
    const refreshHeader = headerValue(req, "x-refresh-secret");
    const authorizedBySecret =
      !!config.webhookSecret &&
      ((!!bearer && safeEquals(bearer, `Bearer ${config.webhookSecret}`)) ||
        (!!refreshHeader && safeEquals(refreshHeader, config.webhookSecret)));
    const adminToken = authenticateToken(req.headers.authorization, loadTokenEntries());
    const authorizedByToken = adminToken?.role === "admin";
    if (!authorizedBySecret && !authorizedByToken) {
      res.status(401).json({
        error:
          "Unauthorized — send the shared secret (Authorization: Bearer <ITGLUE_WEBHOOK_SECRET> or x-refresh-secret header) or an admin bearer token.",
      });
      return;
    }

    const deps = serverIndexerDeps();
    if (!deps) {
      res.status(503).json({
        error:
          "Index refresh unavailable — the server needs ITGLUE_API_KEY and an embedding provider (OPENAI_API_KEY or AZURE_OPENAI_*).",
      });
      return;
    }

    const documentId =
      typeof req.body === "object" && req.body !== null && "document_id" in req.body
        ? String((req.body as { document_id: unknown }).document_id)
        : undefined;

    res.status(202).json({
      accepted: true,
      scope: documentId ? `document ${documentId}` : "all indexed organizations",
    });

    const task = documentId
      ? refreshDocument(deps, documentId).then((message) => console.error(`[index] ${message}`))
      : reindexAll(deps).then((summary) =>
          console.error(
            `[index] Full refresh done: ${summary.indexed}/${summary.total} documents` +
              (summary.errors.length ? `, ${summary.errors.length} error(s)` : "")
          )
        );
    task.catch((err) => console.error(`[index] Refresh failed: ${String(err)}`));
  });

  return app;
}
