import { describe, expect, it } from "vitest";
import { MemoryUploadStore } from "./memory.js";
import { UPLOAD_ID_PATTERN, UPLOAD_TTL_MS } from "./store.js";

const P1 = "editor|alice|";
const P2 = "editor|bob|";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("MemoryUploadStore", () => {
  it("issues a ticket pointing at this server's /upload route", async () => {
    const store = new MemoryUploadStore("https://mcp.example.com/");
    const ticket = await store.issue(P1, "diagram.png");
    expect(ticket.upload_id).toMatch(UPLOAD_ID_PATTERN);
    expect(ticket.method).toBe("PUT");
    expect(ticket.url).toBe(`https://mcp.example.com/upload/${ticket.upload_id}`);
    expect(ticket.auth).toBe("same-as-mcp");
    expect(store.size).toBe(1);
  });

  it("round-trips bytes: issue → receive → take, exactly once", async () => {
    const store = new MemoryUploadStore("http://localhost:3000");
    const { upload_id } = await store.issue(P1, "diagram.png");

    expect(await store.take(P1, upload_id)).toEqual({ status: "pending" });
    expect(await store.receive(P1, upload_id, Buffer.from("bytes"))).toBe("ok");

    const taken = await store.take(P1, upload_id);
    expect(taken.status).toBe("ok");
    if (taken.status === "ok") {
      expect(taken.upload.buffer.toString()).toBe("bytes");
      expect(taken.upload.fileName).toBe("diagram.png");
    }
    expect(await store.take(P1, upload_id)).toEqual({ status: "missing" });
    expect(store.size).toBe(0);
  });

  it("prefers the file name sent with the bytes over the one on the ticket", async () => {
    const store = new MemoryUploadStore("http://localhost:3000");
    const { upload_id } = await store.issue(P1, "ticket-name.png");
    await store.receive(P1, upload_id, Buffer.from("x"), "sent-name.png");
    const taken = await store.take(P1, upload_id);
    expect(taken.status === "ok" && taken.upload.fileName).toBe("sent-name.png");
  });

  it("binds tickets to the principal that requested them", async () => {
    const store = new MemoryUploadStore("http://localhost:3000");
    const { upload_id } = await store.issue(P1);
    expect(await store.receive(P2, upload_id, Buffer.from("x"))).toBe("forbidden");
    expect(await store.receive(P1, upload_id, Buffer.from("x"))).toBe("ok");
    // Another principal cannot even learn the slot exists.
    expect(await store.take(P2, upload_id)).toEqual({ status: "missing" });
  });

  it("refuses a second upload to the same slot and unknown slots", async () => {
    const store = new MemoryUploadStore("http://localhost:3000");
    const { upload_id } = await store.issue(P1);
    await store.receive(P1, upload_id, Buffer.from("x"));
    expect(await store.receive(P1, upload_id, Buffer.from("y"))).toBe("already-uploaded");
    expect(await store.receive(P1, "nope", Buffer.from("y"))).toBe("not-found");
  });

  it("expires slots after the TTL", async () => {
    const c = clock();
    const store = new MemoryUploadStore("http://localhost:3000", c.now);
    const { upload_id } = await store.issue(P1);
    c.advance(UPLOAD_TTL_MS + 1);
    // The sweep drops expired slots before lookup, so a late PUT sees "not-found".
    expect(await store.receive(P1, upload_id, Buffer.from("x"))).toBe("not-found");
    expect(await store.take(P1, upload_id)).toEqual({ status: "missing" });
    expect(store.size).toBe(0);
  });

  it("enforces the per-file and total size caps", async () => {
    const store = new MemoryUploadStore("http://localhost:3000", Date.now, 10, 15);
    const a = await store.issue(P1);
    const b = await store.issue(P1);
    expect(await store.receive(P1, a.upload_id, Buffer.alloc(11))).toBe("too-large");
    expect(await store.receive(P1, a.upload_id, Buffer.alloc(10))).toBe("ok");
    expect(await store.receive(P1, b.upload_id, Buffer.alloc(6))).toBe("too-large");
    expect(await store.receive(P1, b.upload_id, Buffer.alloc(5))).toBe("ok");
  });
});
