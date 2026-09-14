/**
 * Shared helpers for tools that upload binary content (attachments, document
 * images): resolve the caller's chosen source to bytes and validate the result.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { Transport } from "../config.js";

/** Reject files large enough to bloat the JSON payload / API limits. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class UploadInputError extends Error {}

export type BinarySourceArgs = {
  content_base64?: string;
  url?: string;
  file_path?: string;
};

/** Zod fields shared by every upload tool — exactly one source must be given. */
export const binarySourceFields = {
  content_base64: z
    .string()
    .optional()
    .describe("Base64-encoded file bytes (a leading data: URI prefix is stripped)"),
  url: z.string().optional().describe("URL the server fetches and base64-encodes"),
  file_path: z
    .string()
    .optional()
    .describe("Local filesystem path to read (stdio transport only)"),
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
 * Exactly one of content_base64 / url / file_path must be provided; file_path
 * is only honoured on the local stdio transport.
 */
export async function resolveBytes(
  args: BinarySourceArgs,
  transport: Transport
): Promise<{ buffer: Buffer; inferredName?: string }> {
  const sources = [args.content_base64, args.url, args.file_path].filter((v) => v !== undefined);
  if (sources.length === 0) {
    throw new UploadInputError(
      "Provide exactly one image source: content_base64, url, or file_path."
    );
  }
  if (sources.length > 1) {
    throw new UploadInputError(
      "Provide only one image source (content_base64, url, or file_path), not several."
    );
  }

  if (args.content_base64 !== undefined) {
    return { buffer: decodeBase64Input(args.content_base64) };
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

/**
 * Resolve, size-check, and name an upload in one step. Returns the base64
 * payload IT Glue expects plus the final file name (which must carry an
 * extension so IT Glue can detect the content type).
 */
export async function prepareUpload(
  args: BinarySourceArgs & { file_name?: string },
  transport: Transport
): Promise<{ content: string; fileName: string; bytes: number }> {
  const { buffer, inferredName } = await resolveBytes(args, transport);

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

  return { content: buffer.toString("base64"), fileName, bytes: buffer.length };
}
