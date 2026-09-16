import { describe, expect, it } from "vitest";
import { assertRenderableImage, resolveBytes, sniffImage } from "./binary-input.js";

/** Smallest valid PNG (1×1, from the IT Glue API docs example). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * The header a colleague's failed upload started with (1100×321 palette PNG)
 * — valid signature and IHDR, but the rest never arrived. IT Glue answered
 * Paperclip::Errors::NotIdentifiedByImageMagickError.
 */
const PNG_TRUNCATED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAABEwAAAFBCAMAAABaecrxAAAARVBMVEX////+/Pz58fH139/s2dbW09LPnJutameHQjyaJyfBdnXR",
  "base64"
);

describe("sniffImage", () => {
  it("identifies a complete PNG", () => {
    expect(sniffImage(PNG_1X1)).toEqual({ mime: "image/png", complete: true });
  });

  it("flags a PNG without its IEND trailer as truncated", () => {
    expect(sniffImage(PNG_TRUNCATED)).toEqual({ mime: "image/png", complete: false });
  });

  it("identifies JPEG, GIF, WebP, BMP, TIFF and SVG by magic bytes", () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]))).toEqual({
      mime: "image/jpeg",
      complete: true,
    });
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]))).toEqual({
      mime: "image/jpeg",
      complete: false,
    });
    expect(sniffImage(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"))).toEqual({
      mime: "image/gif",
      complete: true,
    });
    const webp = Buffer.alloc(20);
    webp.write("RIFF", 0, "latin1");
    webp.writeUInt32LE(12, 4);
    webp.write("WEBP", 8, "latin1");
    expect(sniffImage(webp)).toEqual({ mime: "image/webp", complete: true });
    expect(sniffImage(Buffer.from("BM\x00\x00", "latin1"))?.mime).toBe("image/bmp");
    expect(sniffImage(Buffer.from("II*\0\x08\x00\x00\x00", "latin1"))?.mime).toBe("image/tiff");
    expect(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/></svg>'))).toEqual({
      mime: "image/svg+xml",
      complete: true,
    });
  });

  it("returns null for non-image data", () => {
    expect(sniffImage(Buffer.from("Hello, world"))).toBeNull();
    expect(sniffImage(Buffer.from("%PDF-1.7 ..."))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe("assertRenderableImage", () => {
  it("passes a complete image through", () => {
    expect(assertRenderableImage(PNG_1X1).mime).toBe("image/png");
  });

  it("explains truncation instead of letting IT Glue answer NotIdentifiedByImageMagick", () => {
    expect(() => assertRenderableImage(PNG_TRUNCATED)).toThrow(/truncated.*image\/png|image\/png data is truncated/);
    expect(() => assertRenderableImage(PNG_TRUNCATED)).toThrow(/url \/ file_path/);
  });

  it("rejects non-image bytes with guidance to use url/file_path", () => {
    expect(() => assertRenderableImage(Buffer.from("not an image"))).toThrow(/not a recognizable image/);
  });
});

describe("resolveBytes with upload_id", () => {

  it("hands back the staged bytes and file name", async () => {
    const staged = {
      take: async (id: string) =>
        id === "abc"
          ? ({ status: "ok", upload: { buffer: Buffer.from("bytes"), fileName: "staged.png" } } as const)
          : ({ status: "missing" } as const),
    };
    const out = await resolveBytes({ upload_id: "abc" }, "http", staged);
    expect(out.buffer.toString()).toBe("bytes");
    expect(out.inferredName).toBe("staged.png");
  });

  it("explains pending, missing, and disabled staging", async () => {
    const pending = { take: async () => ({ status: "pending" } as const) };
    await expect(resolveBytes({ upload_id: "x" }, "http", pending)).rejects.toThrow(/No bytes have been received/);
    const missing = { take: async () => ({ status: "missing" } as const) };
    await expect(resolveBytes({ upload_id: "x" }, "http", missing)).rejects.toThrow(/unknown, expired/);
    await expect(resolveBytes({ upload_id: "x" }, "http", null)).rejects.toThrow(/not enabled on this server/);
  });

  it("counts upload_id as one of the mutually exclusive sources", async () => {
    await expect(resolveBytes({ upload_id: "x", url: "https://a/b.png" }, "http", null)).rejects.toThrow(
      /only one image source/
    );
  });
});
