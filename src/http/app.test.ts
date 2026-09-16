import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import type { ServerConfig } from "../config.js";
import { originAllowed, resolveAuth } from "./app.js";

const TOKEN_VARS = ["MCP_TOKENS_VIEWER", "MCP_TOKENS_EDITOR", "MCP_TOKENS_ADMIN"] as const;

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    transport: "http",
    port: 3000,
    baseUrl: "https://api.itglue.com",
    apiKey: "server-key",
    clientKeyMode: "with-token",
    allowedOrigins: [],
    webhookSecret: undefined,
    vectorIndexPath: "./vector-index.json",
    advancedToolset: false,
    uploadStaging: "off",
    publicBaseUrl: "http://localhost:3000",
    azureStorage: undefined,
    ...overrides,
  };
}

function makeRequest(headers: Record<string, string>): Request {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = value;
  return { headers: lowered } as unknown as Request;
}

describe("resolveAuth", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of TOKEN_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    process.env.MCP_TOKENS_VIEWER = "vlabel:vtok";
    process.env.MCP_TOKENS_EDITOR = "elabel:etok";
    process.env.MCP_TOKENS_ADMIN = "alabel:atok";
  });

  afterEach(() => {
    for (const name of TOKEN_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("maps each token to its role and the server key", () => {
    const config = makeConfig();
    for (const [token, role, label] of [
      ["vtok", "viewer", "vlabel"],
      ["etok", "editor", "elabel"],
      ["atok", "admin", "alabel"],
    ] as const) {
      const auth = resolveAuth(makeRequest({ authorization: `Bearer ${token}` }), config);
      expect(auth).toMatchObject({ ok: true, role, label, apiKey: "server-key", keyHash: null });
    }
  });

  it("rejects missing or wrong tokens with 401", () => {
    const config = makeConfig();
    expect(resolveAuth(makeRequest({}), config)).toMatchObject({ ok: false, status: 401 });
    expect(resolveAuth(makeRequest({ authorization: "Bearer nope" }), config)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("BYOK with-token: requires a valid token, then grants admin with the client key", () => {
    const config = makeConfig({ clientKeyMode: "with-token" });

    const noToken = resolveAuth(makeRequest({ "x-itglue-api-key": "client-key" }), config);
    expect(noToken).toMatchObject({ ok: false, status: 401 });

    const withToken = resolveAuth(
      makeRequest({ authorization: "Bearer vtok", "x-itglue-api-key": "client-key" }),
      config
    );
    expect(withToken).toMatchObject({ ok: true, role: "admin", apiKey: "client-key" });
    if (withToken.ok) {
      expect(withToken.label.startsWith("vlabel+byok:")).toBe(true);
      expect(withToken.keyHash).toHaveLength(64);
    }
  });

  it("BYOK open: the IT Glue key alone authenticates", () => {
    const config = makeConfig({ clientKeyMode: "open" });
    const auth = resolveAuth(makeRequest({ "x-itglue-api-key": "client-key" }), config);
    expect(auth).toMatchObject({ ok: true, role: "admin", apiKey: "client-key" });
    if (auth.ok) expect(auth.label.startsWith("byok:")).toBe(true);
  });

  it("BYOK disabled: the header is rejected even with a valid token", () => {
    const config = makeConfig({ clientKeyMode: "disabled" });
    const auth = resolveAuth(
      makeRequest({ authorization: "Bearer atok", "x-itglue-api-key": "client-key" }),
      config
    );
    expect(auth).toMatchObject({ ok: false, status: 401 });
  });

  it("same client key always produces the same keyHash; different keys differ", () => {
    const config = makeConfig({ clientKeyMode: "open" });
    const a1 = resolveAuth(makeRequest({ "x-itglue-api-key": "key-a" }), config);
    const a2 = resolveAuth(makeRequest({ "x-itglue-api-key": "key-a" }), config);
    const b = resolveAuth(makeRequest({ "x-itglue-api-key": "key-b" }), config);
    if (a1.ok && a2.ok && b.ok) {
      expect(a1.keyHash).toBe(a2.keyHash);
      expect(a1.keyHash).not.toBe(b.keyHash);
    } else {
      throw new Error("expected all to authenticate");
    }
  });

  it("dev passthrough: no tokens configured → admin with a warning label", () => {
    for (const name of TOKEN_VARS) delete process.env[name];
    const auth = resolveAuth(makeRequest({}), makeConfig());
    expect(auth).toMatchObject({ ok: true, role: "admin", label: "dev-unauthenticated" });
  });

  it("no server key and no client key → 401 explaining the options", () => {
    const auth = resolveAuth(
      makeRequest({ authorization: "Bearer vtok" }),
      makeConfig({ apiKey: undefined })
    );
    expect(auth).toMatchObject({ ok: false, status: 401 });
    if (!auth.ok) expect(auth.message).toContain("x-itglue-api-key");
  });
});

describe("originAllowed", () => {
  it("allows requests without an Origin header (native MCP clients, curl)", () => {
    expect(originAllowed(undefined, [])).toBe(true);
  });

  it("always allows localhost origins", () => {
    expect(originAllowed("http://localhost:3000", [])).toBe(true);
    expect(originAllowed("http://127.0.0.1:5173", [])).toBe(true);
    expect(originAllowed("http://[::1]:8080", [])).toBe(true);
    expect(originAllowed("https://localhost", [])).toBe(true);
  });

  it("rejects external origins not in the allowlist", () => {
    expect(originAllowed("https://evil.example", [])).toBe(false);
    expect(originAllowed("https://localhost.evil.example", [])).toBe(false);
  });

  it("allows exactly-matching allowlisted origins", () => {
    const allowed = ["https://app.example.com"];
    expect(originAllowed("https://app.example.com", allowed)).toBe(true);
    expect(originAllowed("https://app.example.com/", allowed)).toBe(true);
    expect(originAllowed("http://app.example.com", allowed)).toBe(false);
    expect(originAllowed("https://other.example.com", allowed)).toBe(false);
  });

  it("rejects malformed or opaque origins", () => {
    expect(originAllowed("null", [])).toBe(false);
    expect(originAllowed("not a url", [])).toBe(false);
  });
});
