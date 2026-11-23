// Run: yarn test
import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { z } from "zod";
import { findExtraFields, validate } from "./validate";

const paths = (schema: z.ZodType, value: unknown) =>
  findExtraFields(schema, value).map((f) => f.path);
const typeOf = (value: unknown) =>
  findExtraFields(z.object({}), { x: value })[0].type;
const base = z.object({ id: z.number() });

test("reports a new field with its type and a sample", () => {
  assert.deepEqual(findExtraFields(base, { id: 1, extra: "x" }), [
    { path: "extra", type: "string", sample: '"x"' },
  ]);
});

test("reports nothing when the data matches the schema", () => {
  assert.deepEqual(paths(base, { id: 1 }), []);
});

test("gives the full path in nested objects", () => {
  const schema = z.object({ a: z.object({ b: z.object({ c: z.string() }) }) });
  assert.deepEqual(paths(schema, { a: { b: { c: "x", d: 1 } } }), ["a.b.d"]);
});

test("goes into arrays and records without index or key", () => {
  const list = z.object({ items: z.array(z.object({ name: z.string() })) });
  assert.deepEqual(paths(list, { items: [{ name: "a", origin: "fr" }] }), [
    "items.origin",
  ]);
  const rec = z.record(z.string(), z.object({ value: z.number() }));
  assert.deepEqual(paths(rec, { fat: { value: 1, per_serving: 2 } }), [
    "per_serving",
  ]);
});

test("does not crash on a field named constructor or toString", () => {
  assert.deepEqual(paths(base, { id: 1, constructor: "x", toString: "y" }), [
    "constructor",
    "toString",
  ]);
});

test("sees through optional, nullable, default, lazy, transform and preprocess", () => {
  const inner = z.object({ b: z.string() });
  const wrapped = z.object({ a: inner.nullable().optional().default(null) });
  assert.deepEqual(paths(wrapped, { a: { b: "x", e: 1 } }), ["a.e"]);
  assert.deepEqual(
    paths(
      z.lazy(() => inner),
      { b: "x", e: 1 },
    ),
    ["e"],
  );
  assert.deepEqual(
    paths(
      inner.transform((o) => o.b),
      { b: "x", e: 1 },
    ),
    ["e"],
  );
  assert.deepEqual(
    paths(
      z.preprocess((v) => v, inner),
      { b: "x", e: 1 },
    ),
    ["e"],
  );
});

test("unions: follows the right option, the most specific one", () => {
  const two = z.union([
    z.object({ a: z.string() }),
    z.object({ b: z.number() }),
  ]);
  assert.deepEqual(paths(two, { b: 2, e: 1 }), ["e"]);
  const nested = z.union([
    z.object({ a: z.string() }),
    z.object({ a: z.string(), b: z.string() }),
  ]);
  assert.deepEqual(paths(nested, { a: "x", b: "y", c: 1 }), ["c"]);
  const mixed = z.object({
    v: z.union([z.string(), z.object({ n: z.number() })]).nullable(),
  });
  assert.deepEqual(paths(mixed, { v: { n: 1, e: 2 } }), ["v.e"]);
  const tagged = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), x: z.string() }),
    z.object({ kind: z.literal("b"), y: z.string() }),
  ]);
  assert.deepEqual(paths(tagged, { kind: "b", y: "z", e: 1 }), ["e"]);
});

test("intersections: a field known on one side is not extra", () => {
  const schema = z.object({ a: z.string() }).and(z.object({ b: z.string() }));
  assert.deepEqual(paths(schema, { a: "x", b: "y", e: 1 }), ["e"]);
});

test("describes types and truncates samples", () => {
  assert.equal(typeOf(null), "null");
  assert.equal(typeOf([1, 2]), "number[]");
  assert.equal(typeOf(["a", null]), "(string | null)[]");
  assert.equal(typeOf([]), "unknown[]");
  assert.equal(typeOf({ a: 1 }), "object");
  const [field] = findExtraFields(base, { id: 1, long: "x".repeat(200) });
  assert.ok(field.sample.length <= 81 && field.sample.endsWith("…"));
});

// --- Alerts: Postgres and the webhook are mocked
type Mode = { insert?: "ok" | "conflict" | "down"; alert?: "ok" | "fail" };

const simulate = ({ insert = "ok", alert = "ok" }: Mode = {}) => {
  process.env.ALERT_WEBHOOK_URL = "https://hooks.example.test/alerts";
  const queries: string[] = [];
  const alerts: string[] = [];
  mock.method(pg.Pool.prototype as any, "query", async (sql: string) => {
    queries.push(sql);
    const isInsert = sql.startsWith("INSERT");
    if (isInsert && insert === "down") throw new Error("ECONNREFUSED");
    return { rowCount: isInsert && insert === "conflict" ? 0 : 1 };
  });
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    alerts.push(JSON.parse(String(init.body)).text);
    return new Response(null, { status: alert === "fail" ? 500 : 200 });
  });
  mock.method(console, "error", () => {});
  return { queries, alerts };
};

afterEach(() => mock.restoreAll());

const product = z.object({
  name: z.string(),
  items: z.array(z.object({ price: z.number() })),
});

test("one alert per new field, even across several items", async () => {
  const { queries, alerts } = simulate();
  const item = {
    name: "a",
    items: [
      { price: 1, origin: "fr" },
      { price: 2, origin: "it" },
    ],
  };
  assert.equal(await validate("src-once", product, item), true);
  assert.equal(await validate("src-once", product, item), true);
  assert.equal(queries.filter((q) => q.startsWith("INSERT")).length, 1);
  assert.deepEqual(alerts, [
    '[src-once] new fields:\n• items.origin: string (e.g. "fr")',
  ]);
});

test("no alert when another job already reported the field", async () => {
  const { alerts } = simulate({ insert: "conflict" });
  await validate("src-conflict", product, { name: "a", items: [], extra: 1 });
  assert.deepEqual(alerts, []);
});

test("alerts anyway when the database is down", async () => {
  const { alerts } = simulate({ insert: "down" });
  await validate("src-down", product, { name: "a", items: [], extra: 1 });
  assert.equal(alerts.length, 1);
});

test("forgets the field in the database when the alert fails", async () => {
  const { queries } = simulate({ alert: "fail" });
  await validate("src-fail", product, { name: "a", items: [], extra: 1 });
  assert.ok(queries.some((q) => q.startsWith("DELETE FROM known_fields")));
});

test("invalid data: false, and one alert per field despite indexes", async () => {
  const { alerts } = simulate();
  const bad = { name: "a", items: [{ price: "x" }, { price: "y" }] };
  assert.equal(await validate("src-invalid", product, bad), false);
  assert.equal(await validate("src-invalid", product, bad), false);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^\[src-invalid\] invalid data:\n• items\.price: /);
  assert.equal(alerts[0].split("\n").length, 2);
});

test("two items in parallel: one database write, one alert", async () => {
  const { queries, alerts } = simulate();
  const item = { name: "a", items: [], extra: 1 };
  await Promise.all([
    validate("src-parallel", product, item),
    validate("src-parallel", product, item),
  ]);
  assert.equal(queries.filter((q) => q.startsWith("INSERT")).length, 1);
  assert.equal(alerts.length, 1);
});

test("a failing webhook never throws out of validate", async () => {
  simulate({ alert: "fail" });
  const bad = { name: 1, items: [], extra: 1 };
  assert.equal(await validate("src-webhook-down", product, bad), false);
});
