/**
 * Shared helpers for tools that upload binary content (attachments, document
 * images): resolve the caller's chosen source to bytes and validate the result.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { Transport } from "../config.js";
import type { StagedSource } from "../uploads/store.js";

/** Reject files large enough to bloat the JSON payload / API limits. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class UploadInputError extends Error {}

export type BinarySourceArgs = {
  content_base64?: string;
  url?: string;
  file_path?: string;
  upload_id?: string;
};

/** Zod fields shared by every upload tool — exactly one source must be given. */
export const binarySourceFields = {
  content_base64: z
    .string()
    .optional()
    .describe("Base64-encoded file bytes (a leading data: URI prefix is stripped) — small files only"),
  url: z.string().optional().describe("URL the server fetches and base64-encodes"),
  file_path: z
    .string()
    .optional()
    .describe("Local filesystem path to read (stdio transport only)"),
  upload_id: z
    .string()
    .optional()
    .describe(
      "ID from itglue_request_upload after the client has PUT the file to the returned URL — the server reads the bytes itself"
    ),
};

/**
 * Decode a base64 input into bytes, tolerating a `data:<mime>;base64,` prefix
 * (which browsers and many tools prepend). Whitespace/newlines are ignored by
 * Buffer's base64 decoder, so the result is normalized on re-encode.
 */
export function decodeBase64Input(input: string): Buffer {
  const stripped = input.startsWith("data:") ? input.slice(input.indexOf(",") + 1) : input;
  return Buffer.from(stripped, "base64");
}

/**
 * Resolve the caller's chosen source to raw bytes plus an inferred file name.
 * Exactly one of content_base64 / url / file_path / upload_id must be
 * provided; file_path is only honoured on the local stdio transport and
 * upload_id only when the server has a staging backend.
 */
export async function resolveBytes(
  args: BinarySourceArgs,
  transport: Transport,
  staged: StagedSource | null = null
): Promise<{ buffer: Buffer; inferredName?: string }> {
  const sources = [args.content_base64, args.url, args.file_path, args.upload_id].filter(
    (v) => v !== undefined
  );
  if (sources.length === 0) {
    throw new UploadInputError(
      "Provide exactly one image source: content_base64, url, file_path, or upload_id."
    );
  }
  if (sources.length > 1) {
    throw new UploadInputError(
      "Provide only one image source (content_base64, url, file_path, or upload_id), not several."
    );
  }

  if (args.content_base64 !== undefined) {
    return { buffer: decodeBase64Input(args.content_base64) };
  }

  if (args.upload_id !== undefined) {
    if (!staged) {
      throw new UploadInputError(
        "Staged uploads are not enabled on this server (UPLOAD_STAGING=off), so upload_id cannot be used — " +
          "pass url or content_base64 instead."
      );
    }
    const result = await staged.take(args.upload_id);
    if (result.status === "pending") {
      throw new UploadInputError(
        `No bytes have been received for upload_id ${args.upload_id} yet — PUT the file to the URL from ` +
          "itglue_request_upload first, then call this tool again."
      );
    }
    if (result.status === "missing") {
      throw new UploadInputError(
        `upload_id ${args.upload_id} is unknown, expired (tickets live 15 minutes), already used, or belongs ` +
          "to another session. Request a new one with itglue_request_upload and PUT the file again."
      );
    }
    return { buffer: result.upload.buffer, inferredName: result.upload.fileName };
  }

  if (args.url !== undefined) {
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      throw new UploadInputError(`Invalid url "${args.url}".`);
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new UploadInputError(`Failed to fetch url (HTTP ${res.status}).`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, inferredName: basename(url.pathname) || undefined };
  }

  // file_path
  if (transport !== "stdio") {
    throw new UploadInputError(
      "file_path is only available on the local stdio transport; use content_base64 or url instead."
    );
  }
  const buffer = await readFile(args.file_path!);
  return { buffer, inferredName: basename(args.file_path!) };
}

export interface ImageSniff {
  mime: string;
  /** False when the container's end-of-image marker is missing — the data was cut off. */
  complete: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identify an image by its magic bytes and check that its trailer is present.
 * IT Glue runs uploads through ImageMagick and rejects anything it cannot
 * identify (`Paperclip::Errors::NotIdentifiedByImageMagickError`) — in
 * practice that is base64 an assistant synthesized or a real file whose
 * base64 got truncated in transit. Catching it here yields a message that
 * says what actually went wrong. Returns null for non-image data.
 */
export function sniffImage(buf: Buffer): ImageSniff | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // A PNG ends with the IEND chunk: length(4) "IEND" crc(4).
    const complete = buf.length >= 16 && buf.subarray(-8, -4).toString("latin1") === "IEND";
    return { mime: "image/png", complete };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const complete = buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
    return { mime: "image/jpeg", complete };
  }
  const head6 = buf.subarray(0, 6).toString("latin1");
  if (head6 === "GIF87a" || head6 === "GIF89a") {
    return { mime: "image/gif", complete: buf[buf.length - 1] === 0x3b };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    // RIFF carries its own length: header(8) + declared size.
    return { mime: "image/webp", complete: buf.length >= buf.readUInt32LE(4) + 8 };
  }
  if (buf.subarray(0, 2).toString("latin1") === "BM") return { mime: "image/bmp", complete: true };
  const head4 = buf.subarray(0, 4).toString("latin1");
  if (head4 === "II*\0" || head4 === "MM\0*") return { mime: "image/tiff", complete: true };
  const text = buf.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) {
    return { mime: "image/svg+xml", complete: buf.toString("utf8").includes("</svg>") };
  }
  return null;
}

/**
 * Throw a descriptive UploadInputError unless `buf` is a complete image of a
 * type IT Glue can render. Used by the document-image tools (attachments may
 * legitimately be PDFs, configs, etc., so they skip this).
 */
export function assertRenderableImage(buf: Buffer): ImageSniff {
  const sniff = sniffImage(buf);
  if (!sniff) {
    throw new UploadInputError(
      "The data is not a recognizable image (expected PNG, JPEG, GIF, WebP, BMP, TIFF or SVG). " +
        "IT Glue would reject it as NotIdentifiedByImageMagick. If content_base64 was written or " +
        "reconstructed by the assistant rather than copied from a real file, it is not a real image — " +
        "pass a url IT Glue's server can fetch, or file_path on a local stdio run."
    );
  }
  if (!sniff.complete) {
    throw new UploadInputError(
      `The ${sniff.mime} data is truncated — the file header is valid but the end-of-image marker is ` +
        "missing, so the base64 was cut off in transit (long tool arguments often are). IT Glue would " +
        "reject it as NotIdentifiedByImageMagick. Re-send the complete file, or use url / file_path " +
        "so the server reads the bytes itself."
    );
  }
  return sniff;
}

/**
 * Resolve, size-check, and name an upload in one step. Returns the base64
 * payload IT Glue expects plus the final file name (which must carry an
 * extension so IT Glue can detect the content type) and the raw bytes for
 * further validation.
 */
export async function prepareUpload(
  args: BinarySourceArgs & { file_name?: string },
  transport: Transport,
  staged: StagedSource | null = null
): Promise<{ content: string; fileName: string; bytes: number; buffer: Buffer }> {
  const { buffer, inferredName } = await resolveBytes(args, transport, staged);

  if (buffer.length === 0) {
    throw new UploadInputError("The image source produced no data.");
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new UploadInputError(
      `File is ${buffer.length} bytes; the limit is ${MAX_UPLOAD_BYTES} bytes.`
    );
  }

  const fileName = args.file_name ?? inferredName;
  if (!fileName || !/\.[^.\s]+$/.test(fileName)) {
    throw new UploadInputError(
      "file_name is required and must include an extension (e.g. diagram.png)."
    );
  }

  return { content: buffer.toString("base64"), fileName, bytes: buffer.length, buffer };
}
