/** Text formatting helpers for tool output. */

/** Hard cap on tool response size, to protect the model's context window. */
export const RESPONSE_CHAR_LIMIT = 25_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  trade: "™",
};

/** Extract an attribute's value from a raw HTML tag string, case-insensitively. */
function tagAttr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match?.[1] ?? "";
}

/** Convert an HTML fragment to readable plain text (markdown-ish). */
export function htmlToText(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = tagAttr(tag, "src");
      if (!src) return "";
      return `![${tagAttr(tag, "alt")}](${src})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr)>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => "#".repeat(Number(level)) + " ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match)
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clip text to the response limit, appending a hint when truncation happened. */
export function clip(text: string, hint?: string): string {
  if (text.length <= RESPONSE_CHAR_LIMIT) return text;
  const note = hint ?? "Use pagination or filters to narrow the result.";
  return (
    text.slice(0, RESPONSE_CHAR_LIMIT) +
    `\n\n---\n[Truncated at ${RESPONSE_CHAR_LIMIT.toLocaleString()} characters. ${note}]`
  );
}

export function pageFooter(totalCount: number, pageNumber: number, hasMore: boolean): string {
  const lines = ["---", `Page ${pageNumber} | ${totalCount} total`];
  if (hasMore) lines.push(`More available — request page_number: ${pageNumber + 1}`);
  return lines.join("\n");
}

/** Minimal shape of a Gallery/Step section's gallery info (see DocumentSection). */
export interface GallerySectionLike {
  document_gallery_id?: number | null;
  document_images?: Array<{ id: string; attributes?: Record<string, unknown> }> | null;
}

/** Compact image records (id, name, size) from a section's nested document-images. */
export function galleryImages(
  section: GallerySectionLike
): Array<{ id: string; name: string; size?: number }> {
  return (section.document_images ?? []).map((img) => {
    const attrs = img.attributes ?? {};
    const size = attrs.size;
    return {
      id: img.id,
      name: String(attrs.name ?? "(unnamed)"),
      ...(typeof size === "number" ? { size } : {}),
    };
  });
}

/** Markdown lines describing a Gallery/Step section's gallery id and images; empty for other sections. */
export function galleryLines(section: GallerySectionLike): string[] {
  const lines: string[] = [];
  if (section.document_gallery_id != null) {
    lines.push(
      `- **Gallery ID**: ${section.document_gallery_id} (pass as gallery_id to itglue_create_document_image)`
    );
  }
  const images = galleryImages(section);
  if (images.length > 0) {
    lines.push(`- **Images** (${images.length}):`);
    for (const img of images) {
      lines.push(`  - ${img.name} (image ID: ${img.id}${img.size !== undefined ? `, ${img.size} bytes` : ""})`);
    }
  }
  return lines;
}

/** "Document::Heading" → "Heading" */
export function sectionKind(resourceType: string | null | undefined): string {
  if (!resourceType) return "Unknown";
  const idx = resourceType.lastIndexOf("::");
  return idx === -1 ? resourceType : resourceType.slice(idx + 2);
}
