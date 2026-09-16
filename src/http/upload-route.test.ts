import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { ServerConfig } from "../config.js";
import { MemoryUploadStore } from "../uploads/memory.js";
import { createApp, principalFor } from "./app.js";

const TOKEN_VARS = ["MCP_TOKENS_VIEWER", "MCP_TOKENS_EDITOR", "MCP_TOKENS_ADMIN"] as const;

const config: ServerConfig = {
  transport: "http",
  port: 0,
  baseUrl: "https://api.itglue.com",
  apiKey: "server-key",
  clientKeyMode: "with-token",
  allowedOrigins: [],
  advancedToolset: false,
  webhookSecret: undefined,
  vectorIndexPath: "./vector-index.json",
  uploadStaging: "memory",
  publicBaseUrl: "http://localhost",
  azureStorage: undefined,
};

describe("PUT /upload/:id", () => {
  const saved: Record<string, string | undefined> = {};
  let server: Server;
  let base: string;
  let store: MemoryUploadStore;

  beforeEach(() => {
    for (const name of TOKEN_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    process.env.MCP_TOKENS_EDITOR = "alice:etok,bob:btok";
  });
  afterEach(() => {
    for (const name of TOKEN_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  beforeAll(async () => {
    store = new MemoryUploadStore("http://localhost");
    const app = createApp(config, { uploads: store });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });
  afterAll(() => {
    server.close();
  });

  const alice = principalFor("editor", "alice", null);
  const put = (id: string, body: Buffer | string, headers: Record<string, string>) =>
    fetch(`${base}/upload/${id}`, { method: "PUT", body, headers });

  it("stores bytes for the principal that owns the slot and hands them to take()", async () => {
    const { upload_id } = await store.issue(alice, "d.png");
    const res = await put(upload_id, Buffer.from("PNGDATA"), {
      Authorization: "Bearer etok",
      "x-file-name": "sent.png",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upload_id, bytes: 7 });

    const taken = await store.take(alice, upload_id);
    expect(taken.status).toBe("ok");
    if (taken.status === "ok") {
      expect(taken.upload.buffer.toString()).toBe("PNGDATA");
      expect(taken.upload.fileName).toBe("sent.png");
    }
  });

  it("requires the same credentials as /mcp", async () => {
    const { upload_id } = await store.issue(alice);
    expect((await put(upload_id, "x", {})).status).toBe(401);
    expect((await put(upload_id, "x", { Authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("refuses another principal's slot, unknown slots, and empty bodies", async () => {
    const { upload_id } = await store.issue(alice);
    expect((await put(upload_id, "x", { Authorization: "Bearer btok" })).status).toBe(403);
    expect((await put("A".repeat(24), "x", { Authorization: "Bearer etok" })).status).toBe(404);
    expect((await put("short", "x", { Authorization: "Bearer etok" })).status).toBe(404);
    expect((await put(upload_id, "", { Authorization: "Bearer etok" })).status).toBe(400);
  });

  it("answers 409 when a slot is filled twice", async () => {
    const { upload_id } = await store.issue(alice);
    await put(upload_id, "one", { Authorization: "Bearer etok" });
    expect((await put(upload_id, "two", { Authorization: "Bearer etok" })).status).toBe(409);
  });
});

describe("createApp without a staging store", () => {
  it("does not expose /upload at all", async () => {
    const app = createApp({ ...config, uploadStaging: "off" }, { uploads: null });
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
    });
    const address = s.address();
    const url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    const res = await fetch(`${url}/upload/${"A".repeat(24)}`, { method: "PUT", body: "x" });
    expect(res.status).toBe(404);
    s.close();
  });
});
