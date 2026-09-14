/**
 * Curated IT Glue REST endpoint catalog for the advanced toolset
 * (itglue_find_endpoint / itglue_get).
 *
 * Hand-maintained from https://api.itglue.com/developer/ — IT Glue publishes
 * no OpenAPI spec, so unlike mcp-connectwise-psa's generated catalog this
 * file IS the source of truth. Keep entries alphabetized by path (after the
 * synthetic grammar entry) and prefer adding notes over dropping endpoints.
 *
 * Attribute keys are shown snake_case (this server's convention); the wire
 * format is kebab-case and itglue_get converts both ways.
 */

export interface EndpointDoc {
  module: string;
  path: string;
  methods: string;
  summary: string;
  /** Curated tool(s) that already wrap this endpoint — prefer them. */
  coveredBy?: string;
  /** Most useful query params / filters. */
  keyParams?: string;
  /** Common attribute keys in the response. */
  commonFields?: string;
  notes?: string;
}

export const ITGLUE_ENDPOINTS: EndpointDoc[] = [
  {
    module: "meta",
    path: "(query grammar)",
    methods: "—",
    summary:
      "How IT Glue JSON:API queries work: filters are EXACT match (filter[name] included — partial name search " +
      "requires scanning client-side; commas inside a filter value act as value-list separators). Sort with " +
      "sort=field or sort=-field for descending. Page with page_number / page_size (max 1000). Sideload related " +
      "resources with include=a,b. Attribute keys are snake_case in this server (kebab-case on the wire); " +
      "operators like [ne] go through raw_params, e.g. {\"filter[document-folder-id][ne]\": \"null\"}.",
    notes: "Query syntax reference — not a callable endpoint.",
  },
  {
    module: "attachments",
    path: "/{resource_type}/{resource_id}/relationships/attachments",
    methods: "POST, PATCH, DELETE",
    summary: "Upload, rename, or delete file attachments on any record (documents, configurations, flexible assets, …).",
    coveredBy: "itglue_list_attachments, itglue_create_attachment, itglue_delete_attachment",
    notes: "Write-only endpoint — there is no GET index, so it is not reachable via itglue_get; use the curated tools.",
  },
  {
    module: "configurations",
    path: "/configurations",
    methods: "GET, POST",
    summary: "All configurations (devices/assets) across organizations.",
    keyParams:
      "filter[organization_id], filter[name], filter[configuration_type_id], filter[configuration_status_id], " +
      "filter[serial_number], filter[psa_id], filter[rmm_id] (+filter[rmm_integration_type]), filter[archived]",
    commonFields: "name, hostname, primary_ip, serial_number, configuration_type_name, configuration_status_name, operating_system_name, organization_id",
  },
  {
    module: "configurations",
    path: "/configurations/{id}",
    methods: "GET, PATCH",
    summary: "One configuration with full attributes.",
    keyParams: "include=configuration_interfaces,adapters_resources",
  },
  {
    module: "configurations",
    path: "/configurations/{configuration_id}/relationships/configuration_interfaces",
    methods: "GET, POST, PATCH",
    summary: "Network interfaces (IPs, MACs) of one configuration.",
    commonFields: "name, ip_address, mac_address, primary, notes",
  },
  {
    module: "configurations",
    path: "/configuration_statuses",
    methods: "GET, POST",
    summary: "Configuration status list (Active, Retired, …).",
    commonFields: "name, created_at, updated_at",
  },
  {
    module: "configurations",
    path: "/configuration_types",
    methods: "GET, POST",
    summary: "Configuration type list (Firewall, Server, Workstation, …).",
    keyParams: "filter[name]",
    commonFields: "name, created_at, updated_at",
  },
  {
    module: "contacts",
    path: "/contacts",
    methods: "GET, POST",
    summary: "All contacts across organizations.",
    keyParams:
      "filter[organization_id], filter[first_name], filter[last_name], filter[title], filter[contact_type_id], " +
      "filter[important], filter[primary_email], filter[psa_id]",
    commonFields: "first_name, last_name, title, contact_type_name, location_name, important, notes, organization_id, contact_emails, contact_phones",
  },
  {
    module: "contacts",
    path: "/contact_types",
    methods: "GET, POST",
    summary: "Contact type list (Approver, Champion, …).",
    commonFields: "name",
  },
  {
    module: "countries",
    path: "/countries",
    methods: "GET",
    summary: "Country reference list (for locations).",
    keyParams: "filter[name], filter[iso]",
  },
  {
    module: "documents",
    path: "/document_images",
    methods: "POST",
    summary:
      "Upload an image INTO a document (base64 JSON body). target {type: 'document', id} = inline image — the " +
      "response's inline_resource_url is the <img src> to use in Text/Step section HTML; target {type: 'gallery', id} " +
      "files it into a Gallery/Step section's gallery (its document_gallery_id).",
    coveredBy: "itglue_create_document_image",
    notes:
      "Write-only — not reachable via itglue_get. Distinct from attachments, which never render in the document body. " +
      "Nested keys are spelled as documented: image.file-name.",
  },
  {
    module: "documents",
    path: "/document_images/{id}",
    methods: "GET, DELETE",
    summary: "One document image: name, size, owning document/gallery, target, inline_resource_url, presigned S3 URLs (~1 h).",
    coveredBy: "itglue_get_document_image, itglue_delete_document_image",
    commonFields:
      "name, size, document_id, document_gallery_id, target, inline_resource_url, original_src, slim_src, thumbnail_src",
  },
  {
    module: "documents",
    path: "/documents/{document_id}/relationships/sections",
    methods: "GET, POST",
    summary:
      "Sections of one document (Document::Text / Heading / Gallery / Step). Text/Step carry content (raw HTML with " +
      "relative inline-image paths — use for editing) and rendered_content (presigned S3 image URLs — display only); " +
      "Gallery/Step carry document_gallery_id and a nested document_images array.",
    coveredBy: "itglue_list_document_sections, itglue_get_document_section, itglue_create_document_section",
    keyParams: "filter[resource_type], sort=sort",
    commonFields: "resource_type, content, rendered_content, level, duration, sort, document_gallery_id, document_images",
    notes: "/{id} supports GET, PATCH, DELETE (itglue_get/update/delete_document_section).",
  },
  {
    module: "documents",
    path: "/organizations/{organization_id}/relationships/documents",
    methods: "GET",
    summary: "Documents of one organization (knowledge-base articles).",
    coveredBy: "itglue_list_documents, itglue_get_document, itglue_vector_search",
    keyParams: "filter[document_folder_id] (use raw_params {\"filter[document-folder-id][ne]\": \"null\"} for folder contents)",
    commonFields: "name, public, draft, document_folder_id, created_at, updated_at",
    notes: "Partially undocumented API — filter[name] is ignored here; the curated tools scan client-side.",
  },
  {
    module: "domains",
    path: "/domains",
    methods: "GET",
    summary: "All tracked domains (registrar, expiry) across organizations.",
    keyParams: "filter[organization_id], include=passwords is NOT available here",
    commonFields: "name, registrar_name, expires_on, notes, organization_id, created_at, updated_at",
  },
  {
    module: "domains",
    path: "/organizations/{organization_id}/relationships/domains",
    methods: "GET",
    summary: "Domains of one organization.",
    commonFields: "name, registrar_name, expires_on, organization_id",
  },
  {
    module: "expirations",
    path: "/expirations",
    methods: "GET",
    summary: "Expirations (domains, SSL certificates, licenses, warranties, agreements) across organizations.",
    keyParams:
      "filter[organization_id], filter[resource_type_name] (Domain, Certificate, License, Warranty, …), " +
      "filter[expiration_date], filter[description], sort=expiration_date",
    commonFields: "description, expiration_date, resource_type_name, resource_name, organization_id",
  },
  {
    module: "expirations",
    path: "/organizations/{organization_id}/relationships/expirations",
    methods: "GET",
    summary: "Expirations of one organization.",
    keyParams: "filter[resource_type_name], sort=expiration_date",
  },
  {
    module: "exports",
    path: "/exports",
    methods: "GET, POST, DELETE",
    summary: "Account data exports — list export jobs or request a new one (POST is admin-side, use with care).",
    commonFields: "downloaded, size, created_at, updated_at",
    notes: "GET lists export jobs; the download itself happens in the IT Glue UI.",
  },
  {
    module: "flexible assets",
    path: "/flexible_asset_types",
    methods: "GET, POST, PATCH",
    summary: "Flexible asset type definitions (custom asset schemas).",
    coveredBy: "itglue_list_flexible_asset_types, itglue_get_flexible_asset_type",
    keyParams: "filter[name] (exact), filter[icon], filter[enabled]",
    commonFields: "name, description, icon, enabled",
  },
  {
    module: "flexible assets",
    path: "/flexible_asset_types/{type_id}/relationships/flexible_asset_fields",
    methods: "GET, POST, PATCH, DELETE",
    summary: "Field definitions of one flexible asset type (names, kinds, required flags).",
    coveredBy: "itglue_get_flexible_asset_type",
    commonFields: "name, kind, required, hint, order, tag_type",
  },
  {
    module: "flexible assets",
    path: "/flexible_assets",
    methods: "GET, POST",
    summary: "Flexible asset records of one type.",
    coveredBy: "itglue_list_flexible_assets, itglue_get_flexible_asset",
    keyParams: "filter[flexible_asset_type_id] (REQUIRED), filter[organization_id], filter[name]",
    commonFields: "name, traits (user-defined keys, not converted), organization_id, flexible_asset_type_name",
    notes: "GET without filter[flexible_asset_type_id] is rejected by the API.",
  },
  {
    module: "flexible assets",
    path: "/flexible_assets/{id}",
    methods: "GET, PATCH, DELETE",
    summary: "One flexible asset with full traits.",
    coveredBy: "itglue_get_flexible_asset",
  },
  {
    module: "groups",
    path: "/groups",
    methods: "GET",
    summary: "IT Glue user groups.",
    keyParams: "filter[name]",
    commonFields: "name, created_at, updated_at",
  },
  {
    module: "locations",
    path: "/locations",
    methods: "GET",
    summary: "All locations (sites/addresses) across organizations.",
    keyParams: "filter[organization_id], filter[name], filter[city], filter[region_id], filter[country_id], filter[psa_id]",
    commonFields: "name, address_1, address_2, city, postal_code, region_name, country_name, phone, primary, organization_id",
  },
  {
    module: "locations",
    path: "/organizations/{organization_id}/relationships/locations",
    methods: "GET, POST, PATCH",
    summary: "Locations of one organization.",
    commonFields: "name, address_1, city, primary",
  },
  {
    module: "logs",
    path: "/logs",
    methods: "GET",
    summary: "Activity logs (who viewed/edited what) — Enterprise plan only.",
    keyParams: "filter[created_at], page_size, sort=-created_at",
    commonFields: "action, resource_type, resource_name, member_name, created_at",
    notes: "Only available on Enterprise accounts; 403 otherwise.",
  },
  {
    module: "manufacturers",
    path: "/manufacturers",
    methods: "GET, POST",
    summary: "Hardware manufacturer reference list.",
    keyParams: "filter[name]",
    commonFields: "name",
  },
  {
    module: "manufacturers",
    path: "/manufacturers/{manufacturer_id}/relationships/models",
    methods: "GET, POST",
    summary: "Models of one manufacturer.",
    commonFields: "name, manufacturer_id",
  },
  {
    module: "models",
    path: "/models",
    methods: "GET",
    summary: "All hardware models.",
    keyParams: "filter[id]",
    commonFields: "name, manufacturer_id",
  },
  {
    module: "operating systems",
    path: "/operating_systems",
    methods: "GET",
    summary: "Operating system reference list.",
    keyParams: "filter[name]",
    commonFields: "name, platform_id",
  },
  {
    module: "organizations",
    path: "/organizations",
    methods: "GET, POST",
    summary: "All organizations (clients, vendors, …).",
    coveredBy: "itglue_list_organizations",
    keyParams:
      "filter[name] (exact), filter[organization_type_id], filter[organization_status_id], filter[psa_id], " +
      "filter[created_at], filter[updated_at], sort=name",
    commonFields: "name, short_name, organization_type_name, organization_status_name, quick_notes, alert, description",
  },
  {
    module: "organizations",
    path: "/organizations/{id}",
    methods: "GET, PATCH, DELETE",
    summary: "One organization with full attributes.",
    coveredBy: "itglue_get_organization",
  },
  {
    module: "organizations",
    path: "/organization_statuses",
    methods: "GET, POST",
    summary: "Organization status list (Active, Inactive, …).",
    commonFields: "name",
  },
  {
    module: "organizations",
    path: "/organization_types",
    methods: "GET, POST",
    summary: "Organization type list (Customer, Vendor, Partner, …).",
    commonFields: "name",
  },
  {
    module: "passwords",
    path: "/passwords",
    methods: "GET, POST, PATCH, DELETE",
    summary: "Password/credential records.",
    keyParams: "filter[organization_id], filter[name]",
    notes:
      "INTENTIONALLY NOT REACHABLE via itglue_get — password resources are excluded from this MCP server " +
      "so credential values never enter the model context. Retrieve credentials in the IT Glue UI.",
  },
  {
    module: "passwords",
    path: "/password_categories",
    methods: "GET, POST",
    summary: "Password category reference list (metadata only — contains no credential values).",
    commonFields: "name",
  },
  {
    module: "platforms",
    path: "/platforms",
    methods: "GET",
    summary: "Platform reference list (for operating systems).",
    commonFields: "name",
  },
  {
    module: "regions",
    path: "/regions",
    methods: "GET",
    summary: "Region/state reference list (for locations).",
    keyParams: "filter[name], filter[iso], filter[country_id]",
  },
  {
    module: "related items",
    path: "/{resource_type}/{resource_id}/relationships/related_items",
    methods: "POST, PATCH, DELETE",
    summary: "Link records to each other (related items sidebar).",
    notes: "Write-only endpoint — related items appear in GET responses of the parent record, not via a GET index.",
  },
  {
    module: "users",
    path: "/users",
    methods: "GET",
    summary: "IT Glue account users.",
    keyParams: "filter[name], filter[email], filter[role_name] (Administrator, Creator, Editor, Lite, Read-only)",
    commonFields: "first_name, last_name, email, role_name, reputation, my_glue_account_id, last_sign_in_at",
  },
  {
    module: "users",
    path: "/users/{id}",
    methods: "GET, PATCH",
    summary: "One IT Glue user.",
  },
  {
    module: "users",
    path: "/user_metrics",
    methods: "GET",
    summary: "Per-user activity counts (created/edited/viewed) by date.",
    keyParams: "filter[user_id], filter[organization_id], filter[resource_type], filter[date]",
    commonFields: "user_id, organization_id, resource_type, created, viewed, edited, deleted, date",
  },
];
