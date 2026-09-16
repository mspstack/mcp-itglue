import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolRegistrar } from "../auth/roles.js";
import type { Role } from "../auth/tokens.js";
import { MemoryUploadStore } from "../uploads/memory.js";
import type { UploadStore, UploadTicket } from "../uploads/store.js";
import { curlFor, registerUploadTools } from "./uploads.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

function setup(store: UploadStore, role: Role = "editor") {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  registerUploadTools(new ToolRegistrar(server, role), store, "editor|alice|");
  return tools;
}

describe("curlFor", () => {
  it("memory tickets need the client's own MCP credentials", () => {
    const ticket: UploadTicket = {
      upload_id: "id",
      method: "PUT",
      url: "https://mcp.example.com/upload/id",
      headers: { "Content-Type": "application/octet-stream" },
      auth: "same-as-mcp",
      expires_at: "2026-01-01T00:00:00.000Z",
      max_bytes: 1,
    };
    expect(curlFor(ticket, "d.png")).toBe(
      'curl -sS -X PUT -H "Authorization: Bearer <YOUR MCP TOKEN>" -H "Content-Type: application/octet-stream" --data-binary "@d.png" "https://mcp.example.com/upload/id"'
    );
  });

  it("azure tickets carry the blob headers and no bearer", () => {
    const ticket: UploadTicket = {
      upload_id: "id",
      method: "PUT",
      url: "https://acct.blob.core.windows.net/c/h/id?sig=x",
      headers: { "x-ms-blob-type": "BlockBlob" },
      auth: "none",
      expires_at: "2026-01-01T00:00:00.000Z",
      max_bytes: 1,
    };
    const curl = curlFor(ticket);
    expect(curl).toContain('-H "x-ms-blob-type: BlockBlob"');
    expect(curl).not.toContain("Authorization");
    expect(curl).toContain('"@<path-to-file>"');
  });
});

describe("itglue_request_upload", () => {
  it("issues a slot and explains the two remaining steps", async () => {
    const store = new MemoryUploadStore("https://mcp.example.com");
    const tools = setup(store);
    const result = await tools.get("itglue_request_upload")!({
      file_name: "diagram.png",
      response_format: "markdown",
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    const id = text.match(/upload_id: ([A-Za-z0-9_-]{24})/)?.[1];
    expect(id).toBeTruthy();
    expect(text).toContain(`https://mcp.example.com/upload/${id}`);
    expect(text).toContain("curl -sS -X PUT");
    expect(text).toContain('upload_id: "' + id + '"');
    expect(store.size).toBe(1);
  });

  it("returns the ticket as JSON with the curl attached", async () => {
    const tools = setup(new MemoryUploadStore("https://mcp.example.com"));
    const result = await tools.get("itglue_request_upload")!({ response_format: "json" });
    const parsed = JSON.parse(result.content[0]!.text) as UploadTicket & { curl: string };
    expect(parsed.method).toBe("PUT");
    expect(parsed.curl).toContain(parsed.url);
  });

  it("is write-tier: viewers do not see it", () => {
    expect(setup(new MemoryUploadStore("http://x"), "viewer").has("itglue_request_upload")).toBe(false);
    expect(setup(new MemoryUploadStore("http://x"), "editor").has("itglue_request_upload")).toBe(true);
  });
});
