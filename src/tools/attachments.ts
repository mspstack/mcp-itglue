/** Attachment tools: attach an image/file to any supported record, list, delete. */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import { buildQuery, type ITGlueClient } from "../itglue/client.js";
import type { Transport } from "../config.js";
import type { StagedSource } from "../uploads/store.js";
import { clip, pageFooter } from "../format.js";
import {
  binarySourceFields,
  MAX_UPLOAD_BYTES,
  prepareUpload,
  type BinarySourceArgs,
} from "./binary-input.js";
import {
  emptyPageData,
  failure,
  json,
  pageData,
  pageNumberField,
  pageOutputShape,
  pageSizeField,
  pick,
  responseFormatField,
  structured,
  text,
} from "./shared.js";

export { decodeBase64Input } from "./binary-input.js";
/** @deprecated alias kept for callers/tests — see MAX_UPLOAD_BYTES. */
export const MAX_ATTACHMENT_BYTES = MAX_UPLOAD_BYTES;

/**
 * IT Glue resource types that support attachments, keyed by the exact URL path
 * segment. The attachments endpoint is nested under the parent record:
 *   POST /:segment/:id/relationships/attachments
 * Files are sent base64-encoded inside ordinary application/vnd.api+json JSON —
 * no multipart — so this rides the existing JSON client.
 *
 * NOTE: attachments land in the record's "Attachments" side panel. They do NOT
 * appear inside a document's body — for that, use the document-images tools
 * (src/tools/document-images.ts), which upload via POST /document_images and
 * return an inline_resource_url to embed as <img src="…"> in section HTML.
 */
const RESOURCE_TYPES = [
  "documents",
  "flexible_assets",
  "configurations",
  "contacts",
  "passwords",
  "domains",
  "locations",
  "ssl_certificates",
  "tickets",
  "checklists",
] as const;

type ResourceType = (typeof RESOURCE_TYPES)[number];

const ATTACHMENT_SUMMARY_KEYS = [
  "id",
  "name",
  "attachment_file_name",
  "attachment_content_type",
  "attachment_file_size",
  "download_url",
  "created_at",
] as const;

export function attachmentsPath(
  resourceType: ResourceType,
  resourceId: number,
  attachmentId?: number
): string {
  const base = `/${resourceType}/${resourceId}/relationships/attachments`;
  return attachmentId === undefined ? base : `${base}/${attachmentId}`;
}

/** The JSON:API attributes IT Glue expects for an attachment upload. */
export function attachmentAttributes(content: string, fileName: string): Record<string, unknown> {
  // `attachment` is a single top-level attribute holding a nested object; the
  // client kebab-cases only top-level keys, so `content`/`file_name` survive.
  return { attachment: { content, file_name: fileName } };
}

function attachmentSummary(a: Record<string, unknown>): string {
  const name = a.attachment_file_name ?? a.name ?? "(unnamed)";
  const lines = [`## ${name} (ID: ${a.id})`];
  if (a.attachment_content_type) lines.push(`- **Type**: ${a.attachment_content_type}`);
  if (a.attachment_file_size) lines.push(`- **Size**: ${a.attachment_file_size} bytes`);
  if (a.download_url) lines.push(`- **Download**: ${a.download_url}`);
  if (a.created_at) lines.push(`- **Created**: ${a.created_at}`);
  lines.push("");
  return lines.join("\n");
}

export function registerAttachmentTools(
  reg: ToolRegistrar,
  client: ITGlueClient,
  transport: Transport,
  staged: StagedSource | null = null
): void {
  reg.register(
    {
      name: "itglue_create_attachment",
      title: "Create IT Glue Attachment",
      description:
        "Attach a file (PDF, image, config export, …) to a record (document, flexible asset, configuration, etc.). " +
        "The file appears in the record's Attachments side panel — it is NOT shown inside a document's body. " +
        "To place a picture inside a document (inline in a Text/Step section or in a Gallery), use " +
        "itglue_create_document_image instead. Provide exactly one source: content_base64 (small files only), " +
        "url (the server fetches it), file_path (local stdio runs only), or upload_id (a file the client PUT via " +
        "itglue_request_upload — use this for anything on the client's disk). Give file_name with an extension " +
        "(e.g. network-diagram.pdf) so IT Glue detects the type; it is inferred from url/file_path/upload when " +
        `omitted. Max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
      inputSchema: {
        resource_type: z.enum(RESOURCE_TYPES).describe("The record type to attach to"),
        resource_id: z.number().int().positive().describe("The parent record ID"),
        file_name: z
          .string()
          .optional()
          .describe("Display file name with extension; inferred from url/file_path if omitted"),
        ...binarySourceFields,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (
      args: BinarySourceArgs & {
        resource_type: ResourceType;
        resource_id: number;
        file_name?: string;
        response_format: "markdown" | "json";
      }
    ) => {
      try {
        const { content, fileName } = await prepareUpload(args, transport, staged);

        const attachment = await client.create<Record<string, unknown>>(
          attachmentsPath(args.resource_type, args.resource_id),
          "attachments",
          attachmentAttributes(content, fileName)
        );

        if (args.response_format === "json") return text(json(attachment));
        return text(
          `Attachment created (ID: ${attachment.id}, file: ${fileName}) on ${args.resource_type} ${args.resource_id}.`
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_list_attachments",
      title: "List IT Glue Attachments",
      description:
        "List the attachments on a record (document, flexible asset, configuration, etc.), with " +
        "attachment IDs (needed for delete), file names, content types, and download URLs.",
      inputSchema: {
        resource_type: z.enum(RESOURCE_TYPES).describe("The record type"),
        resource_id: z.number().int().positive().describe("The parent record ID"),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      outputSchema: pageOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      resource_type: ResourceType;
      resource_id: number;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const page = await client.getMany<Record<string, unknown>>(
          attachmentsPath(args.resource_type, args.resource_id),
          buildQuery({ pageNumber: args.page_number, pageSize: args.page_size })
        );

        if (page.items.length === 0) {
          return structured("This record has no attachments.", emptyPageData(args.page_number));
        }
        const data = pageData({
          ...page,
          items: page.items.map((a) => pick(a, ATTACHMENT_SUMMARY_KEYS)),
        });
        if (args.response_format === "json") return structured(clip(json(data)), data);

        const lines = [`# Attachments (${page.totalCount} total)`, ""];
        for (const a of page.items) lines.push(attachmentSummary(a));
        lines.push(pageFooter(page.totalCount, page.pageNumber, page.hasMore));
        return structured(clip(lines.join("\n")), data);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_delete_attachment",
      title: "Delete IT Glue Attachment",
      description:
        "PERMANENTLY delete an attachment from a record. This cannot be undone. Find the attachment " +
        "ID with itglue_list_attachments.",
      inputSchema: {
        resource_type: z.enum(RESOURCE_TYPES).describe("The record type"),
        resource_id: z.number().int().positive().describe("The parent record ID"),
        attachment_id: z.number().int().positive().describe("The attachment ID to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args: { resource_type: ResourceType; resource_id: number; attachment_id: number }) => {
      try {
        // IT Glue deletes related attachments via a bulk body on the collection
        // endpoint (there is no single id-in-path DELETE for attachments).
        await client.destroy(attachmentsPath(args.resource_type, args.resource_id), {
          data: [{ type: "attachments", attributes: { id: args.attachment_id } }],
        });
        return text(
          `Attachment ${args.attachment_id} deleted from ${args.resource_type} ${args.resource_id}.`
        );
      } catch (error) {
        return failure(error);
      }
    }
  );
}
