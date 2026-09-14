/** JSON:API wire types and IT Glue resource shapes. */

export interface JsonApiResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

export interface JsonApiDocument {
  data: JsonApiResource | JsonApiResource[];
  /** Sideloaded related resources (present when the query used `include`). */
  included?: JsonApiResource[];
  meta?: {
    "current-page"?: number;
    "next-page"?: number | null;
    "prev-page"?: number | null;
    "total-pages"?: number;
    "total-count"?: number;
  };
}

export interface Page<T> {
  items: T[];
  totalCount: number;
  pageNumber: number;
  hasMore: boolean;
}

/**
 * Deserialized resources: `id` + `type` plus attributes with keys converted
 * from kebab-case to snake_case (top level only — nested objects such as
 * flexible-asset traits keep their original keys).
 */

export interface Organization extends Record<string, unknown> {
  id: string;
  type: string;
  name: string;
  description?: string | null;
  organization_type_name?: string | null;
  organization_status_name?: string | null;
  short_name?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Document extends Record<string, unknown> {
  id: string;
  type: string;
  name: string;
  organization_id?: number;
  organization_name?: string | null;
  published?: boolean;
  resource_url?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface DocumentFolder extends Record<string, unknown> {
  id: string;
  type: string;
  name: string;
  organization_id?: number;
  organization_name?: string | null;
  /** Parent folder id; null/absent for a top-level folder. */
  parent_id?: number | null;
  /** Ids of every ancestor folder, root-first. */
  ancestor_ids?: number[] | null;
  documents_count?: number;
  restricted?: boolean;
  resource_url?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface DocumentSection extends Record<string, unknown> {
  id: string;
  type: string;
  document_id?: number;
  /** e.g. "Document::Text", "Document::Heading", "Document::Gallery", "Document::Step" */
  resource_type?: string | null;
  content?: string | null;
  rendered_content?: string | null;
  level?: number | null;
  duration?: number | null;
  sort?: number | null;
  /** Gallery/Step sections: the gallery that holds their images — the `gallery_id` for image uploads. */
  document_gallery_id?: number | null;
  /** Gallery/Step sections: images in the gallery, as nested JSON:API resources (kebab-case attribute keys). */
  document_images?: JsonApiResource[] | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * An image uploaded INTO a document via POST /document_images. `target`
 * decides placement: `{type: "document"}` yields an inline image whose
 * `inline_resource_url` (a relative path) goes into section HTML as
 * `<img src>`; `{type: "gallery"}` files it into a Gallery/Step gallery.
 * The *_src URLs are presigned S3 links that expire after about an hour.
 */
export interface DocumentImage extends Record<string, unknown> {
  id: string;
  type: string;
  name?: string;
  size?: number;
  document_id?: number | null;
  document_gallery_id?: number | null;
  target?: { type: "gallery" | "document"; id: number } | null;
  original_src?: string | null;
  slim_src?: string | null;
  thumbnail_src?: string | null;
  inline_resource_url?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface FlexibleAssetType extends Record<string, unknown> {
  id: string;
  type: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface FlexibleAssetField extends Record<string, unknown> {
  id: string;
  type: string;
  name: string;
  kind?: string;
  hint?: string | null;
  required?: boolean;
  order?: number;
  tag_type?: string | null;
  default_value?: unknown;
}

export interface FlexibleAsset extends Record<string, unknown> {
  id: string;
  type: string;
  organization_id?: number;
  organization_name?: string | null;
  flexible_asset_type_id?: number;
  flexible_asset_type_name?: string | null;
  name?: string;
  traits?: Record<string, unknown>;
  resource_url?: string | null;
  created_at?: string;
  updated_at?: string;
}
