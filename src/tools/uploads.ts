/**
 * itglue_request_upload — hand a client a place to PUT a real file so the
 * bytes never travel through the model. See src/uploads/store.ts.
 */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import type { UploadStore, UploadTicket } from "../uploads/store.js";
import { failure, json, responseFormatField, text } from "./shared.js";

/** Ready-to-run curl for a ticket; the client fills in the file path (and its own MCP credentials in memory mode). */
export function curlFor(ticket: UploadTicket, fileName?: string): string {
  const headers = Object.entries(ticket.headers).map(([k, v]) => `-H "${k}: ${v}"`);
  if (ticket.auth === "same-as-mcp") {
    headers.unshift('-H "Authorization: Bearer <YOUR MCP TOKEN>"');
  }
  const file = fileName ?? "<path-to-file>";
  return `curl -sS -X PUT ${headers.join(" ")} --data-binary "@${file}" "${ticket.url}"`;
}

export function registerUploadTools(reg: ToolRegistrar, store: UploadStore, principal: string): void {
  reg.register(
    {
      name: "itglue_request_upload",
      title: "Request IT Glue Upload Slot",
      description:
        "Get a one-time upload slot for a real file (image, PDF, …) so it can be passed to " +
        "itglue_create_document_image or itglue_create_attachment as upload_id instead of base64. Use this " +
        "whenever the file lives on the client's machine and is more than a few KB — never type base64 by hand. " +
        "Flow: (1) call this with the file_name; (2) run the returned curl (or an equivalent PUT) from a shell; " +
        "(3) call the create tool with upload_id. Slots expire after 15 minutes and are consumed once. " +
        (store.kind === "memory"
          ? "This server stores the file in memory; the PUT must carry the same Authorization / x-itglue-api-key headers as the MCP connection."
          : "This server stages files in Azure Blob Storage; the returned URL is self-authorizing (SAS) — send no other credentials."),
      inputSchema: {
        file_name: z
          .string()
          .optional()
          .describe("File name with extension (e.g. routing-diagram.png); becomes the default name on upload"),
        response_format: responseFormatField,
      },
      // Issuing a slot is harmless by itself, but only writers have anything
      // to do with it, so keep it off the viewer surface.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: { file_name?: string; response_format: "markdown" | "json" }) => {
      try {
        const ticket = await store.issue(principal, args.file_name);
        const curl = curlFor(ticket, args.file_name);
        if (args.response_format === "json") return text(json({ ...ticket, curl }));

        const lines = [
          `Upload slot ready — upload_id: ${ticket.upload_id} (expires ${ticket.expires_at}, max ${Math.floor(ticket.max_bytes / (1024 * 1024))} MB).`,
          "",
          "1. PUT the file from a shell:",
          "```bash",
          curl,
          "```",
          ticket.auth === "same-as-mcp"
            ? "   Replace <YOUR MCP TOKEN> with the bearer token this MCP connection uses (or send x-itglue-api-key if that is how you authenticate)."
            : "   The URL already carries a short-lived signature; send no other credentials.",
          "2. Then call itglue_create_document_image or itglue_create_attachment with:",
          `   upload_id: "${ticket.upload_id}"${args.file_name ? ` (file_name defaults to ${args.file_name})` : ""}`,
        ];
        return text(lines.join("\n"));
      } catch (error) {
        return failure(error);
      }
    }
  );
}
