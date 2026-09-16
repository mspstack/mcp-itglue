import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ITGlueClient } from "../itglue/client.js";
import { toResourcePayload } from "../itglue/client.js";
import { ToolRegistrar } from "../auth/roles.js";
import type { Role } from "../auth/tokens.js";
import {
  appendInlineImage,
  DOCUMENT_IMAGES_PATH,
  documentImageAttributes,
  inlineImageTag,
  registerDocumentImageTools,
} from "./document-images.js";

/** Smallest valid PNG (1×1) — uploads are validated as real images before hitting IT Glue. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("documentImageAttributes → toResourcePayload", () => {
  it("matches the documented POST /document_images body for an inline image", () => {
    const payload = toResourcePayload(
      "document-images",
      documentImageAttributes({ type: "document", id: 42 }, "QUJD", "diagram.png")
    );
    expect(payload).toEqual({
      data: {
        type: "document-images",
        attributes: {
          target: { type: "document", id: 42 },
          image: { content: "QUJD", "file-name": "diagram.png" },
        },
      },
    });
  });

  it("targets a gallery when asked", () => {
    const attrs = documentImageAttributes({ type: "gallery", id: 12 }, "QUJD", "a.jpg");
    expect(attrs.target).toEqual({ type: "gallery", id: 12 });
  });
});

describe("inline image HTML helpers", () => {
  it("builds the img tag from the relative inline_resource_url", () => {
    expect(inlineImageTag("/6255696/docs/17772862/images/27211966")).toBe(
      '<img src="/6255696/docs/17772862/images/27211966">'
    );
  });

  it("appends a block to existing content and tolerates empty content", () => {
    expect(appendInlineImage("<p>Hi</p>", "/1/docs/2/images/3")).toBe(
      '<p>Hi</p><div><img src="/1/docs/2/images/3"></div>'
    );
    expect(appendInlineImage(null, "/1/docs/2/images/3")).toBe(
      '<div><img src="/1/docs/2/images/3"></div>'
    );
  });
});

// ── Handler behaviour ────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

function setup(role: Role = "admin", clientImpl: Partial<ITGlueClient> = {}) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  const client = {
    create: vi.fn(),
    getOne: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(),
    ...clientImpl,
  } as unknown as ITGlueClient;
  registerDocumentImageTools(new ToolRegistrar(server, role), client, "stdio", null);
  return { tools, client: client as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

const uploaded = {
  id: "27211966",
  type: "document-images",
  name: "shot.png",
  size: 5,
  document_id: 17772862,
  document_gallery_id: null,
  target: { type: "document", id: 17772862 },
  inline_resource_url: "/6255696/docs/17772862/images/27211966",
};

describe("itglue_create_document_image", () => {
  it("uploads an inline image and returns the exact <img> tag to embed", async () => {
    const create = vi.fn().mockResolvedValue(uploaded);
    const { tools } = setup("admin", { create } as Partial<ITGlueClient>);

    const result = await tools.get("itglue_create_document_image")!({
      document_id: 17772862,
      file_name: "shot.png",
      content_base64: PNG_1X1,
      response_format: "markdown",
    });

    expect(result.isError).toBeUndefined();
    expect(create).toHaveBeenCalledWith(DOCUMENT_IMAGES_PATH, "document-images", {
      target: { type: "document", id: 17772862 },
      image: { content: PNG_1X1, "file-name": "shot.png" },
    });
    expect(result.content[0]?.text).toContain("27211966");
    expect(result.content[0]?.text).toContain('<img src="/6255696/docs/17772862/images/27211966">');
  });

  it("targets the gallery when gallery_id is given", async () => {
    const create = vi.fn().mockResolvedValue({ ...uploaded, inline_resource_url: null, target: { type: "gallery", id: 12 } });
    const { tools } = setup("admin", { create } as Partial<ITGlueClient>);

    const result = await tools.get("itglue_create_document_image")!({
      document_id: 42,
      gallery_id: 12,
      file_name: "g.jpg",
      content_base64: PNG_1X1,
      response_format: "markdown",
    });

    expect(result.isError).toBeUndefined();
    expect(create.mock.calls[0]?.[2]).toMatchObject({ target: { type: "gallery", id: 12 } });
    expect(result.content[0]?.text).toMatch(/gallery 12/);
  });

  it("appends the image to an existing section when append_to_section_id is given", async () => {
    const create = vi.fn().mockResolvedValue(uploaded);
    const getOne = vi.fn().mockResolvedValue({ id: "31809245", content: "<p>Before</p>" });
    const update = vi.fn().mockResolvedValue({ id: "31809245" });
    const { tools } = setup("admin", { create, getOne, update } as Partial<ITGlueClient>);

    const result = await tools.get("itglue_create_document_image")!({
      document_id: 17772862,
      append_to_section_id: 31809245,
      file_name: "shot.png",
      content_base64: PNG_1X1,
      response_format: "markdown",
    });

    expect(result.isError).toBeUndefined();
    const sectionPath = "/documents/17772862/relationships/sections/31809245";
    expect(getOne).toHaveBeenCalledWith(sectionPath);
    expect(update).toHaveBeenCalledWith(
      sectionPath,
      "document-sections",
      { content: '<p>Before</p><div><img src="/6255696/docs/17772862/images/27211966"></div>' },
      "31809245"
    );
    expect(result.content[0]?.text).toMatch(/Appended to section 31809245/);
  });

  it("refuses append_to_section_id together with gallery_id before uploading", async () => {
    const create = vi.fn();
    const { tools } = setup("admin", { create } as Partial<ITGlueClient>);

    const result = await tools.get("itglue_create_document_image")!({
      document_id: 1,
      gallery_id: 2,
      append_to_section_id: 3,
      file_name: "x.png",
      content_base64: PNG_1X1,
      response_format: "markdown",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/inline images only/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("still validates the byte source like attachments do", async () => {
    const { tools, client } = setup();
    const result = await tools.get("itglue_create_document_image")!({
      document_id: 1,
      file_name: "x.png",
      response_format: "markdown",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/exactly one image source/i);
    expect(client.create).not.toHaveBeenCalled();
  });
});

describe("itglue_get_document_image / itglue_delete_document_image", () => {
  it("get drops the presigned slim/thumbnail URLs but keeps inline_resource_url and original_src", async () => {
    const getOne = vi.fn().mockResolvedValue({
      ...uploaded,
      original_src: "https://s3/original?sig=1",
      slim_src: "https://s3/slim?sig=1",
      thumbnail_src: "https://s3/thumb?sig=1",
    });
    const { tools } = setup("viewer", { getOne } as Partial<ITGlueClient>);

    const result = (await tools.get("itglue_get_document_image")!({
      image_id: 27211966,
      response_format: "json",
    })) as { structuredContent?: { item: Record<string, unknown> } };

    expect(getOne).toHaveBeenCalledWith("/document_images/27211966");
    const item = result.structuredContent!.item;
    expect(item.inline_resource_url).toBe("/6255696/docs/17772862/images/27211966");
    expect(item.original_src).toBe("https://s3/original?sig=1");
    expect(item).not.toHaveProperty("slim_src");
    expect(item).not.toHaveProperty("thumbnail_src");
  });

  it("delete hits the id-in-path endpoint", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const { tools } = setup("editor", { destroy } as Partial<ITGlueClient>);

    const result = await tools.get("itglue_delete_document_image")!({ image_id: 5 });

    expect(result.isError).toBeUndefined();
    expect(destroy).toHaveBeenCalledWith("/document_images/5");
  });

  it("is tiered so editors can create/delete and viewers can only get", () => {
    const viewer = setup("viewer").tools;
    expect(viewer.has("itglue_get_document_image")).toBe(true);
    expect(viewer.has("itglue_create_document_image")).toBe(false);
    expect(viewer.has("itglue_delete_document_image")).toBe(false);

    const editor = setup("editor").tools;
    expect(editor.has("itglue_create_document_image")).toBe(true);
    expect(editor.has("itglue_delete_document_image")).toBe(true);
  });
});

describe("itglue_create_document_image — image validation", () => {
  it("rejects truncated base64 before calling IT Glue, naming the cause", async () => {
    const create = vi.fn();
    const { tools } = setup("admin", { create } as Partial<ITGlueClient>);

    const result = await tools.get("itglue_create_document_image")!({
      document_id: 25040194,
      file_name: "routing-diagram.png",
      // Valid PNG header (1100×321) with the body missing — what a colleague's
      // failed upload looked like; IT Glue answered NotIdentifiedByImageMagickError.
      content_base64:
        "iVBORw0KGgoAAAANSUhEUgAABEwAAAFBCAMAAABaecrxAAAARVBMVEX////+/Pz58fH139/s2dbW09LPnJutameHQjyaJyfBdnXR",
      response_format: "markdown",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/truncated/i);
    expect(result.content[0]?.text).toMatch(/NotIdentifiedByImageMagick/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects non-image bytes before calling IT Glue", async () => {
    const create = vi.fn();
    const { tools } = setup("admin", { create } as Partial<ITGlueClient>);

    const result = await tools.get("itglue_create_document_image")!({
      document_id: 1,
      file_name: "x.png",
      content_base64: Buffer.from("just some text").toString("base64"),
      response_format: "markdown",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not a recognizable image/i);
    expect(create).not.toHaveBeenCalled();
  });
});
