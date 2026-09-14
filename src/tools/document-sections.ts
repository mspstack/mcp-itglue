/** Document section tools: list, get, create, update, delete. */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import type { ITGlueClient } from "../itglue/client.js";
import { buildQuery } from "../itglue/client.js";
import type { DocumentSection } from "../itglue/types.js";
import { clip, galleryImages, galleryLines, htmlToText, pageFooter, sectionKind } from "../format.js";
import { queueDocumentRefresh, type IndexerDeps } from "../vector/indexer.js";
import {
  emptyPageData,
  failure,
  itemOutputShape,
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

/** Summary fields for list items; content becomes a bounded content_preview. */
const SECTION_SUMMARY_KEYS = [
  "id",
  "resource_type",
  "sort",
  "level",
  "duration",
  "document_gallery_id",
  "updated_at",
] as const;
const CONTENT_PREVIEW_CHARS = 300;

function sectionSummaryData(section: DocumentSection): Record<string, unknown> {
  const data = pick(section, SECTION_SUMMARY_KEYS);
  if (section.content) {
    const plain = htmlToText(section.content);
    data.content_preview =
      plain.length > CONTENT_PREVIEW_CHARS ? `${plain.slice(0, CONTENT_PREVIEW_CHARS)}…` : plain;
  }
  const images = galleryImages(section);
  if (images.length > 0) data.images = images;
  return data;
}

/**
 * Text/Step sections carry `content` (raw HTML, inline images as short relative
 * paths — the form needed for editing) and `rendered_content` (the same HTML
 * with ~1.5 KB presigned S3 URLs per image that expire within an hour). Output
 * shows `content`: it is what a caller must round-trip, and it is compact.
 */
function sectionBody(section: DocumentSection): string[] {
  const lines = [section.content ? htmlToText(section.content) : "*No content*"];
  lines.push(...galleryLines(section));
  return lines;
}

const SECTION_TYPES = ["Text", "Heading", "Gallery", "Step"] as const;

function sectionsPath(documentId: number, sectionId?: number): string {
  const base = `/documents/${documentId}/relationships/sections`;
  return sectionId === undefined ? base : `${base}/${sectionId}`;
}

function sectionSummary(section: DocumentSection): string {
  const lines = [
    `### ${sectionKind(section.resource_type)} (ID: ${section.id}, position: ${section.sort ?? "—"})`,
  ];
  if (section.level != null) lines.push(`**Level**: ${section.level}`);
  lines.push(...sectionBody(section));
  if (section.duration != null) lines.push(`- **Duration**: ${section.duration} min`);
  if (section.updated_at) lines.push(`- **Updated**: ${section.updated_at}`);
  lines.push("");
  return lines.join("\n");
}

export function registerDocumentSectionTools(
  reg: ToolRegistrar,
  client: ITGlueClient,
  refreshDeps: IndexerDeps | null
): void {
  reg.register(
    {
      name: "itglue_list_document_sections",
      title: "List IT Glue Document Sections",
      description:
        "List the sections of a document in position order, with content previews and section IDs " +
        "(needed for update/delete operations). List items carry summary fields and a bounded " +
        "content_preview; Gallery/Step items also carry document_gallery_id (the gallery_id for " +
        "itglue_create_document_image) and their images. Use itglue_get_document_section for full content.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      outputSchema: pageOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      document_id: number;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const page = await client.getMany<DocumentSection>(
          sectionsPath(args.document_id),
          buildQuery({ pageNumber: args.page_number, pageSize: args.page_size })
        );

        if (page.items.length === 0) {
          return structured("This document has no sections.", emptyPageData(args.page_number));
        }
        const data = pageData({ ...page, items: page.items.map(sectionSummaryData) });
        if (args.response_format === "json") return structured(clip(json(data)), data);

        const lines = [`# Sections (${page.totalCount} total)`, ""];
        for (const section of page.items) lines.push(sectionSummary(section));
        lines.push(pageFooter(page.totalCount, page.pageNumber, page.hasMore));
        return structured(
          clip(lines.join("\n"), "Fetch single sections with itglue_get_document_section."),
          data
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_get_document_section",
      title: "Get IT Glue Document Section",
      description:
        "Get one document section with its full content (HTML on the wire; markdown output converts to plain " +
        "text). Inline images appear as <img src=\"/org/docs/doc/images/ID\"> relative paths — keep them verbatim " +
        "when editing; the JSON record also has rendered_content with temporary S3 URLs for display.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        section_id: z.number().int().positive().describe("The section ID"),
        response_format: responseFormatField,
      },
      outputSchema: itemOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_id: number; section_id: number; response_format: "markdown" | "json" }) => {
      try {
        const section = await client.getOne<DocumentSection>(
          sectionsPath(args.document_id, args.section_id)
        );
        if (args.response_format === "json") return structured(clip(json(section)), { item: section });

        const lines = [
          `# ${sectionKind(section.resource_type)} section (ID: ${section.id})`,
          "",
          `**Document**: ${args.document_id}`,
          `**Position**: ${section.sort ?? "—"}`,
        ];
        if (section.level != null) lines.push(`**Level**: ${section.level}`);
        if (section.duration != null) lines.push(`**Duration**: ${section.duration} min`);
        lines.push("", ...sectionBody(section));
        return structured(clip(lines.join("\n")), { item: section });
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_create_document_section",
      title: "Create IT Glue Document Section",
      description:
        "Add a section to a document. Types: Text (HTML content), Heading (content = heading text, level 1-6 required), " +
        "Gallery (no content — add pictures afterwards with itglue_create_document_image using the new section's " +
        "document_gallery_id), Step (HTML content, optional duration in minutes). " +
        "IMAGES: to show a picture in Text/Step HTML, first upload it with itglue_create_document_image and use the " +
        "returned inline_resource_url verbatim as <img src=\"/org/docs/doc/images/ID\">. Public https:// image links " +
        "also work; base64/data: URIs and S3 URLs are stripped by IT Glue. Attachments never render in the body.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        section_type: z.enum(SECTION_TYPES).describe("Section type"),
        content: z
          .string()
          .optional()
          .describe("HTML content (Text/Step) or heading text (Heading)"),
        level: z.number().int().min(1).max(6).optional().describe("Heading level 1-6 (required for Heading)"),
        duration: z.number().int().positive().optional().describe("Duration in minutes (Step only)"),
        sort: z.number().int().min(0).optional().describe("Position within the document (0-based)"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: {
      document_id: number;
      section_type: (typeof SECTION_TYPES)[number];
      content?: string;
      level?: number;
      duration?: number;
      sort?: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const section = await client.create<DocumentSection>(
          sectionsPath(args.document_id),
          "document-sections",
          {
            resource_type: `Document::${args.section_type}`,
            content: args.content,
            level: args.level,
            duration: args.duration,
            sort: args.sort,
          }
        );
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");

        if (args.response_format === "json") return text(json(section));
        return text(
          `Section created (ID: ${section.id}, type: ${sectionKind(section.resource_type)}, position: ${section.sort ?? "—"}).`
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_update_document_section",
      title: "Update IT Glue Document Section",
      description:
        "Update a section's content, heading level, duration, or position. Only provided fields change; " +
        "the section type cannot be changed. content REPLACES the whole HTML — fetch the current content first " +
        "and keep existing <img src=\"/org/docs/doc/images/ID\"> tags verbatim, or they are lost. To add a new " +
        "picture, upload it with itglue_create_document_image (or its append_to_section_id shortcut) and embed the " +
        "returned inline_resource_url; base64/data: URIs and S3 URLs are stripped by IT Glue.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        section_id: z.number().int().positive().describe("The section ID to update"),
        content: z.string().optional().describe("New HTML content (or heading text)"),
        level: z.number().int().min(1).max(6).optional().describe("New heading level (Heading only)"),
        duration: z.number().int().positive().optional().describe("New duration in minutes (Step only)"),
        sort: z.number().int().min(0).optional().describe("New position within the document"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      document_id: number;
      section_id: number;
      content?: string;
      level?: number;
      duration?: number;
      sort?: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const section = await client.update<DocumentSection>(
          sectionsPath(args.document_id, args.section_id),
          "document-sections",
          { content: args.content, level: args.level, duration: args.duration, sort: args.sort },
          String(args.section_id)
        );
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");

        if (args.response_format === "json") return text(json(section));
        return text(`Section updated.\n\n${sectionSummary(section)}`);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_delete_document_section",
      title: "Delete IT Glue Document Section",
      description:
        "PERMANENTLY delete one section from a document. This cannot be undone. Useful for restructuring a " +
        "document's layout.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        section_id: z.number().int().positive().describe("The section ID to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      // Editors restructure documents by removing sections; they can already
      // blank section content via update, so this is not gated to admin.
      tier: "write",
    },
    async (args: { document_id: number; section_id: number }) => {
      try {
        await client.destroy(sectionsPath(args.document_id, args.section_id));
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");
        return text(`Section ${args.section_id} deleted from document ${args.document_id}.`);
      } catch (error) {
        return failure(error);
      }
    }
  );
}
