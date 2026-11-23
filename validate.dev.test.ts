// Development mode. A separate file because validate.ts reads NODE_ENV on import,
// and node:test runs each test file in its own process.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { z } from "zod";

process.env.NODE_ENV = "development";
const { validate } = await import("./validate");

test("development: an extra field fails like a strict schema, without database or webhook", async () => {
  const query = mock.method(pg.Pool.prototype as any, "query", async () => ({
    rowCount: 1,
  }));
  const fetch = mock.method(globalThis, "fetch", async () => new Response());
  const warn = mock.method(console, "warn", () => {});
  const schema = z.object({ id: z.number() });

  assert.equal(await validate("src-dev", schema, { id: 1 }), true);
  assert.equal(await validate("src-dev", schema, { id: 1, extra: "x" }), false);
  assert.equal(await validate("src-dev", schema, { id: "x" }), false);
  assert.equal(warn.mock.callCount(), 2);
  assert.equal(query.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});
