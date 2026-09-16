/**
 * Document image tools: put pictures INSIDE a document.
 *
 * IT Glue has two unrelated upload paths and the distinction matters:
 *  - Attachments (POST /:resource/:id/relationships/attachments) land in the
 *    record's Attachments side panel and never render in the document body.
 *  - Document images (POST /document_images) are the pictures the web editor
 *    inserts. `target: {type: "document", id}` makes an INLINE image whose
 *    `inline-resource-url` (a relative path such as /6255696/docs/17772862/images/27211966)
 *    must be used verbatim as <img src> in Text/Step section HTML — IT Glue
 *    parses that path and swaps in presigned S3 URLs in `rendered-content`.
 *    `target: {type: "gallery", id}` files the image into the gallery behind a
 *    Gallery or Step section (its `document-gallery-id`).
 *
 * Remote `<img src="https://…">` links are the only other thing the editor
 * accepts; `data:` URIs and the presigned S3 URLs are rejected/stripped.
 */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import type { ITGlueClient } from "../itglue/client.js";
import type { DocumentImage, DocumentSection } from "../itglue/types.js";
import type { Transport } from "../config.js";
import { queueDocumentRefresh, type IndexerDeps } from "../vector/indexer.js";
import {
  assertRenderableImage,
  binarySourceFields,
  MAX_UPLOAD_BYTES,
  prepareUpload,
  UploadInputError,
  type BinarySourceArgs,
} from "./binary-input.js";
import { failure, itemOutputShape, json, responseFormatField, structured, text } from "./shared.js";

export const DOCUMENT_IMAGES_PATH = "/document_images";

export type ImageTarget = { type: "document" | "gallery"; id: number };

/**
 * The JSON:API attributes IT Glue expects for a document-image upload. Both
 * `target` and `image` are nested objects; the client kebab-cases only
 * top-level keys, so the inner keys are spelled exactly as the API documents
 * them (`file-name`, not file_name — unlike the attachments endpoint).
 */
export function documentImageAttributes(
  target: ImageTarget,
  content: string,
  fileName: string
): Record<string, unknown> {
  return { target, image: { content, "file-name": fileName } };
}

/** The HTML snippet to embed an inline image in Text/Step section content. */
export function inlineImageTag(inlineResourceUrl: string): string {
  return `<img src="${inlineResourceUrl}">`;
}

/** Append an inline image to existing section HTML (wrapped in its own block). */
export function appendInlineImage(content: string | null | undefined, inlineResourceUrl: string): string {
  return `${content ?? ""}<div>${inlineImageTag(inlineResourceUrl)}</div>`;
}

/** Trim the presigned S3 URLs (≈1.5 KB each, hour-long expiry) out of list/structured output. */
const IMAGE_SUMMARY_KEYS = [
  "id",
  "name",
  "size",
  "document_id",
  "document_gallery_id",
  "target",
  "inline_resource_url",
  "created_at",
] as const;

function imageSummary(image: DocumentImage): string {
  const lines = [`# Document image ${image.name ? `${image.name} ` : ""}(ID: ${image.id})`, ""];
  if (image.size != null) lines.push(`**Size**: ${image.size} bytes`);
  if (image.document_id != null) lines.push(`**Document**: ${image.document_id}`);
  if (image.document_gallery_id != null) lines.push(`**Gallery**: ${image.document_gallery_id}`);
  if (image.target) lines.push(`**Target**: ${image.target.type} ${image.target.id}`);
  if (image.inline_resource_url) {
    lines.push(
      `**Inline HTML**: \`${inlineImageTag(image.inline_resource_url)}\` (use this exact src in Text/Step section content)`
    );
  }
  if (image.original_src) lines.push(`**Download (expires ~1 h)**: ${image.original_src}`);
  if (image.created_at) lines.push(`**Created**: ${image.created_at}`);
  return lines.join("\n");
}

export function registerDocumentImageTools(
  reg: ToolRegistrar,
  client: ITGlueClient,
  transport: Transport,
  refreshDeps: IndexerDeps | null
): void {
  reg.register(
    {
      name: "itglue_create_document_image",
      title: "Create IT Glue Document Image",
      description:
        "Upload a picture INTO a document — the only way to get an image to render in a document's body " +
        "(itglue_create_attachment only files it in the Attachments panel). Two placements: " +
        "(1) INLINE — omit gallery_id; the result carries inline_resource_url, a relative path you must use " +
        "verbatim as <img src=\"…\"> in Text/Step section HTML via itglue_create_document_section or " +
        "itglue_update_document_section, or pass append_to_section_id to have this tool append the <img> to an " +
        "existing Text/Step section for you. (2) GALLERY — pass gallery_id (the document_gallery_id shown on a " +
        "Gallery or Step section) to file the image into that gallery. Never put base64/data: URIs or S3 URLs in " +
        "section content; IT Glue strips them. Provide exactly one source: content_base64, url, or file_path " +
        "(local stdio runs only). content_base64 must be the exact bytes of a real image file — never write or " +
        "reconstruct base64 yourself (IT Glue rejects anything ImageMagick cannot decode); for a picture that " +
        "exists on the web or disk prefer url or file_path so the server reads the bytes itself. file_name needs " +
        `an extension (e.g. screenshot.png); inferred from url/file_path when omitted. Max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
      inputSchema: {
        document_id: z.number().int().positive().describe("The document the image belongs to"),
        gallery_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "document_gallery_id of a Gallery/Step section to file the image into; omit for an inline image"
          ),
        append_to_section_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Inline only: ID of an existing Text/Step section to append <div><img src=…></div> to after upload"
          ),
        file_name: z
          .string()
          .optional()
          .describe("File name with extension; inferred from url/file_path if omitted"),
        ...binarySourceFields,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (
      args: BinarySourceArgs & {
        document_id: number;
        gallery_id?: number;
        append_to_section_id?: number;
        file_name?: string;
        response_format: "markdown" | "json";
      }
    ) => {
      try {
        if (args.gallery_id !== undefined && args.append_to_section_id !== undefined) {
          throw new UploadInputError(
            "append_to_section_id applies to inline images only — omit gallery_id to embed in a section."
          );
        }

        const { content, fileName, bytes, buffer } = await prepareUpload(args, transport);
        // Fail fast with a useful message instead of IT Glue's opaque
        // NotIdentifiedByImageMagickError (seen with truncated/synthesized base64).
        assertRenderableImage(buffer);
        const target: ImageTarget =
          args.gallery_id !== undefined
            ? { type: "gallery", id: args.gallery_id }
            : { type: "document", id: args.document_id };

        const image = await client.create<DocumentImage>(
          DOCUMENT_IMAGES_PATH,
          "document-images",
          documentImageAttributes(target, content, fileName)
        );

        let appendedTo: DocumentSection | undefined;
        if (args.append_to_section_id !== undefined) {
          if (!image.inline_resource_url) {
            throw new UploadInputError(
              `Image ${image.id} was uploaded but IT Glue returned no inline_resource_url, so it was not appended to section ${args.append_to_section_id}.`
            );
          }
          const sectionPath = `/documents/${args.document_id}/relationships/sections/${args.append_to_section_id}`;
          const section = await client.getOne<DocumentSection>(sectionPath);
          appendedTo = await client.update<DocumentSection>(
            sectionPath,
            "document-sections",
            { content: appendInlineImage(section.content, image.inline_resource_url) },
            String(args.append_to_section_id)
          );
          queueDocumentRefresh(refreshDeps, args.document_id, "upsert");
        }

        if (args.response_format === "json") {
          return text(json({ image, appended_to_section_id: appendedTo?.id ?? null }));
        }

        const lines = [`Document image created (ID: ${image.id}, file: ${fileName}, ${bytes} bytes).`];
        if (target.type === "gallery") {
          lines.push(`Filed into gallery ${target.id} of document ${args.document_id}.`);
        } else if (image.inline_resource_url) {
          if (appendedTo) {
            lines.push(`Appended to section ${appendedTo.id} of document ${args.document_id}.`);
          } else {
            lines.push(
              `Embed it by putting this exact tag in a Text/Step section's HTML: ${inlineImageTag(image.inline_resource_url)}`
            );
          }
        } else {
          lines.push("IT Glue returned no inline_resource_url; inspect the record with itglue_get_document_image.");
        }
        return text(lines.join("\n"));
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_get_document_image",
      title: "Get IT Glue Document Image",
      description:
        "Get one document image by ID: file name, size, owning document/gallery, the inline_resource_url to " +
        "embed it with, and a presigned download URL (valid ~1 hour). Image IDs appear in section HTML as the " +
        "last path segment of <img src=\"/org/docs/doc/images/ID\"> and in Gallery/Step section image lists.",
      inputSchema: {
        image_id: z.number().int().positive().describe("The document image ID"),
        response_format: responseFormatField,
      },
      outputSchema: itemOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { image_id: number; response_format: "markdown" | "json" }) => {
      try {
        const image = await client.getOne<DocumentImage>(`${DOCUMENT_IMAGES_PATH}/${args.image_id}`);
        const item: Record<string, unknown> = {};
        for (const key of IMAGE_SUMMARY_KEYS) if (image[key] !== undefined) item[key] = image[key];
        if (image.original_src) item.original_src = image.original_src;
        if (args.response_format === "json") return structured(json(item), { item });
        return structured(imageSummary(image), { item });
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_delete_document_image",
      title: "Delete IT Glue Document Image",
      description:
        "PERMANENTLY delete a document image (all size variants). This cannot be undone. Any <img> tag still " +
        "referencing it stays in the section HTML until that section is next saved, when IT Glue drops the broken " +
        "reference — remove the tag yourself with itglue_update_document_section for an immediate clean result.",
      inputSchema: {
        image_id: z.number().int().positive().describe("The document image ID to delete"),
        document_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Owning document ID, if known — used to refresh the search index"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      // Editors curate document content — they can already drop an image by
      // editing the <img> out of a section — so, like deleting a section,
      // this is not gated to admin.
      tier: "write",
    },
    async (args: { image_id: number; document_id?: number }) => {
      try {
        await client.destroy(`${DOCUMENT_IMAGES_PATH}/${args.image_id}`);
        if (args.document_id !== undefined) queueDocumentRefresh(refreshDeps, args.document_id, "upsert");
        return text(`Document image ${args.image_id} deleted.`);
      } catch (error) {
        return failure(error);
      }
    }
  );
}
