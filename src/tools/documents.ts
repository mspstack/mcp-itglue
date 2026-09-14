/** Document tools: list, get, create, update, publish, delete. */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import { buildQuery, bulkDeletePayload, type ITGlueClient } from "../itglue/client.js";
import type { Document, DocumentFolder, DocumentSection } from "../itglue/types.js";
import { clip, galleryLines, htmlToText, pageFooter, sectionKind } from "../format.js";
import { queueDocumentRefresh, type IndexerDeps } from "../vector/indexer.js";
import {
  emptyPageData,
  failure,
  itemOutputShape,
  json,
  nameMatches,
  pageNumberField,
  pageOutputShape,
  pageSizeField,
  paginate,
  pick,
  responseFormatField,
  scanCapNote,
  structured,
  text,
} from "./shared.js";

/** Summary fields for list items — mirrors what documentSummary renders. */
const DOC_SUMMARY_KEYS = [
  "id",
  "name",
  "organization_name",
  "published",
  "updated_at",
  "resource_url",
] as const;

function documentSummary(doc: Document): string {
  const lines = [`## ${doc.name} (ID: ${doc.id})`];
  if (doc.organization_name) lines.push(`- **Organization**: ${doc.organization_name}`);
  lines.push(`- **Published**: ${doc.published ? "Yes" : "No"}`);
  if (doc.updated_at) lines.push(`- **Updated**: ${doc.updated_at}`);
  if (doc.resource_url) lines.push(`- **URL**: ${doc.resource_url}`);
  lines.push("");
  return lines.join("\n");
}

/** Summary fields for folder list items — mirrors what folderSummary renders. */
const FOLDER_SUMMARY_KEYS = [
  "id",
  "name",
  "parent_id",
  "documents_count",
  "restricted",
  "updated_at",
  "resource_url",
] as const;

function folderSummary(folder: DocumentFolder): string {
  const lines = [`## ${folder.name} (ID: ${folder.id})`];
  lines.push(`- **Parent folder**: ${folder.parent_id ?? "none (top level)"}`);
  if (folder.documents_count !== undefined) lines.push(`- **Documents**: ${folder.documents_count}`);
  if (folder.restricted) lines.push(`- **Restricted**: Yes`);
  if (folder.updated_at) lines.push(`- **Updated**: ${folder.updated_at}`);
  if (folder.resource_url) lines.push(`- **URL**: ${folder.resource_url}`);
  lines.push("");
  return lines.join("\n");
}

export function registerDocumentTools(
  reg: ToolRegistrar,
  client: ITGlueClient,
  refreshDeps: IndexerDeps | null
): void {
  reg.register(
    {
      name: "itglue_list_documents",
      title: "List IT Glue Documents",
      description:
        "List documents in an organization, including documents nested in folders. Returns summary metadata only — " +
        "use itglue_get_document for content and the full record. filter_name matches partially and case-insensitively. " +
        "The endpoint returns root-level documents by default, so this tool " +
        "issues a second query for folder-nested documents and merges the results (up to 2x page_size items).",
      inputSchema: {
        organization_id: z.number().int().positive().describe("Organization ID to list documents for"),
        filter_name: z.string().optional().describe("Filter by document name (partial match)"),
        filter_id: z.number().int().positive().optional().describe("Filter by document ID"),
        sort: z.string().optional().describe('Sort field (e.g. "name", "-updated_at")'),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      outputSchema: pageOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      organization_id: number;
      filter_name?: string;
      filter_id?: number;
      sort?: string;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const path = `/organizations/${args.organization_id}/relationships/documents`;
        const dedupe = (docs: Document[]): Document[] => {
          const seen = new Set<string>();
          return docs.filter((doc) => !seen.has(doc.id) && (seen.add(doc.id), true));
        };

        // The documents endpoint IGNORES filter[name], so name search crawls
        // both query variants (root + folder-nested) and filters locally.
        let documents: Document[];
        let totalCount: number;
        let hasMore: boolean;
        let scannedAll = true;
        if (args.filter_name !== undefined) {
          const query = buildQuery({ filters: { id: args.filter_id }, sort: args.sort });
          const rootScan = await client.getAllPages<Document>(path, query);
          const folderScan = await client.getAllPages<Document>(path, {
            ...query,
            "filter[document-folder-id][ne]": "null",
          });
          scannedAll = rootScan.scannedAll && folderScan.scannedAll;
          const matches = dedupe([...rootScan.items, ...folderScan.items]).filter((doc) =>
            nameMatches(doc, args.filter_name!)
          );
          const local = paginate(matches, args.page_number, args.page_size);
          documents = local.items;
          totalCount = local.totalCount;
          hasMore = local.hasMore;
        } else {
          const query = buildQuery({
            filters: { id: args.filter_id },
            pageNumber: args.page_number,
            pageSize: args.page_size,
            sort: args.sort,
          });
          const rootPage = await client.getMany<Document>(path, query);
          const folderPage = await client.getMany<Document>(path, {
            ...query,
            "filter[document-folder-id][ne]": "null",
          });
          documents = dedupe([...rootPage.items, ...folderPage.items]);
          totalCount = rootPage.totalCount + folderPage.totalCount;
          hasMore = rootPage.hasMore || folderPage.hasMore;
        }

        if (documents.length === 0) {
          return structured(
            `No documents found.${scanCapNote(scannedAll)}`,
            emptyPageData(args.page_number)
          );
        }
        const data = {
          items: documents.map((doc) => pick(doc, DOC_SUMMARY_KEYS)),
          total_count: totalCount,
          page_number: args.page_number,
          has_more: hasMore,
        };
        if (args.response_format === "json") {
          return structured(clip(json(data)), data);
        }

        const lines = [`# Documents (${totalCount} total)`, ""];
        for (const doc of documents) lines.push(documentSummary(doc));
        lines.push(pageFooter(totalCount, args.page_number, hasMore));
        return structured(clip(lines.join("\n") + scanCapNote(scannedAll)), data);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_list_document_folders",
      title: "List IT Glue Document Folders",
      description:
        "List the document folders (directories) in an organization, including nested folders. Returns summary " +
        "metadata only (name, parent folder, document count). Use this to discover a document_folder_id for " +
        "itglue_create_document, or to browse an organization's document tree. filter_name matches partially and " +
        "case-insensitively; parent_id is the number in a folder's URL. A folder with parent_id null is top-level.",
      inputSchema: {
        organization_id: z.number().int().positive().describe("Organization ID to list folders for"),
        filter_name: z.string().optional().describe("Filter by folder name (partial match)"),
        filter_id: z.number().int().positive().optional().describe("Filter by folder ID"),
        sort: z.string().optional().describe('Sort field (e.g. "name", "-updated_at")'),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      outputSchema: pageOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      organization_id: number;
      filter_name?: string;
      filter_id?: number;
      sort?: string;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const path = `/organizations/${args.organization_id}/relationships/document_folders`;

        let folders: DocumentFolder[];
        let totalCount: number;
        let hasMore: boolean;
        let scannedAll = true;
        if (args.filter_name !== undefined) {
          // The endpoint ignores filter[name], so crawl all folders and filter locally.
          const scan = await client.getAllPages<DocumentFolder>(
            path,
            buildQuery({ filters: { id: args.filter_id }, sort: args.sort })
          );
          scannedAll = scan.scannedAll;
          const matches = scan.items.filter((folder) => nameMatches(folder, args.filter_name!));
          const local = paginate(matches, args.page_number, args.page_size);
          folders = local.items;
          totalCount = local.totalCount;
          hasMore = local.hasMore;
        } else {
          const page = await client.getMany<DocumentFolder>(
            path,
            buildQuery({
              filters: { id: args.filter_id },
              pageNumber: args.page_number,
              pageSize: args.page_size,
              sort: args.sort,
            })
          );
          folders = page.items;
          totalCount = page.totalCount;
          hasMore = page.hasMore;
        }

        if (folders.length === 0) {
          return structured(`No document folders found.${scanCapNote(scannedAll)}`, emptyPageData(args.page_number));
        }
        const data = {
          items: folders.map((folder) => pick(folder, FOLDER_SUMMARY_KEYS)),
          total_count: totalCount,
          page_number: args.page_number,
          has_more: hasMore,
        };
        if (args.response_format === "json") {
          return structured(clip(json(data)), data);
        }

        const lines = [`# Document folders (${totalCount} total)`, ""];
        for (const folder of folders) lines.push(folderSummary(folder));
        lines.push(pageFooter(totalCount, args.page_number, hasMore));
        return structured(clip(lines.join("\n") + scanCapNote(scannedAll)), data);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_get_document",
      title: "Get IT Glue Document",
      description:
        "Get a document by ID with all of its sections and their content. Section content is stored as HTML; " +
        "markdown output converts it to plain text, with inline images shown as their relative " +
        "/org/docs/doc/images/ID paths and gallery images listed by ID. If the response is truncated, fetch " +
        "individual sections with itglue_get_document_section.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The document ID"),
        response_format: responseFormatField,
      },
      outputSchema: itemOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_id: number; response_format: "markdown" | "json" }) => {
      try {
        const doc = await client.getOne<Document>(`/documents/${args.document_id}`);
        const sections = await client.getMany<DocumentSection>(
          `/documents/${args.document_id}/relationships/sections`,
          { "page[size]": 1000 }
        );

        const item = { ...doc, sections: sections.items };
        if (args.response_format === "json") {
          return structured(clip(json(item)), { item });
        }

        const lines = [`# ${doc.name}`, "", `**ID**: ${doc.id}`];
        if (doc.organization_name) lines.push(`**Organization**: ${doc.organization_name}`);
        lines.push(`**Published**: ${doc.published ? "Yes" : "No"}`);
        if (doc.updated_at) lines.push(`**Updated**: ${doc.updated_at}`);
        if (doc.resource_url) lines.push(`**URL**: ${doc.resource_url}`);
        lines.push("");

        if (sections.items.length === 0) {
          lines.push("*No sections.*");
        } else {
          lines.push(`## Sections (${sections.items.length})`, "");
          for (const section of sections.items) {
            lines.push(`### ${sectionKind(section.resource_type)} (ID: ${section.id}, position: ${section.sort ?? "—"})`);
            if (section.level != null) lines.push(`**Level**: ${section.level}`);
            lines.push(section.content ? htmlToText(section.content) : "*No content*");
            lines.push(...galleryLines(section));
            lines.push("");
          }
        }

        return structured(
          clip(lines.join("\n"), "Fetch individual sections with itglue_get_document_section."),
          { item }
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_create_document",
      title: "Create IT Glue Document",
      description:
        "Create a new document as a DRAFT in an organization. Add content with itglue_create_document_section, " +
        "then make it visible with itglue_publish_document.",
      inputSchema: {
        organization_id: z.number().int().positive().describe("Organization to create the document in"),
        name: z.string().min(1).describe("Document name/title"),
        document_folder_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Folder to place the document in (the number in the folder's URL); root when omitted"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: {
      organization_id: number;
      name: string;
      document_folder_id?: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const doc = await client.create<Document>("/documents", "documents", {
          organization_id: args.organization_id,
          name: args.name,
          document_folder_id: args.document_folder_id,
        });
        queueDocumentRefresh(refreshDeps, doc.id, "upsert");

        if (args.response_format === "json") return text(json(doc));
        return text(
          [
            "# Document created (draft)",
            "",
            `**ID**: ${doc.id}`,
            `**Name**: ${doc.name}`,
            "",
            "Next: add content with itglue_create_document_section, then itglue_publish_document.",
          ].join("\n")
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_update_document",
      title: "Update IT Glue Document",
      description:
        "Rename a document (metadata only). To change content, use itglue_update_document_section.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The document ID to update"),
        name: z.string().min(1).describe("New document name"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_id: number; name: string; response_format: "markdown" | "json" }) => {
      try {
        const doc = await client.update<Document>(
          `/documents/${args.document_id}`,
          "documents",
          { name: args.name },
          String(args.document_id)
        );
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");

        if (args.response_format === "json") return text(json(doc));
        return text(`Document updated.\n\n${documentSummary(doc)}`);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_publish_document",
      title: "Publish IT Glue Document",
      description: "Publish a draft document, making it visible to users with access.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The document ID to publish"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_id: number }) => {
      try {
        await client.patchAction(`/documents/${args.document_id}/publish`);
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");
        return text(`Document ${args.document_id} published.`);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_delete_documents",
      title: "Delete IT Glue Documents",
      description:
        "PERMANENTLY delete one or more documents, including all their sections. This cannot be undone.",
      inputSchema: {
        document_ids: z
          .array(z.number().int().positive())
          .min(1)
          .describe("IDs of the documents to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_ids: number[] }) => {
      try {
        await client.destroy("/documents", bulkDeletePayload("documents", args.document_ids));
        for (const id of args.document_ids) queueDocumentRefresh(refreshDeps, id, "remove");
        return text(`Deleted ${args.document_ids.length} document(s): ${args.document_ids.join(", ")}`);
      } catch (error) {
        return failure(error);
      }
    }
  );
}
