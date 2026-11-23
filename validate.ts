// SPDX-License-Identifier: MIT
// Copyright (c) 2026 JKS9: https://github.com/JKS9/zod-schema-drift

import { z } from "zod";
import { Pool } from "pg";

// CREATE TABLE known_fields (
//   source text NOT NULL,
//   field  text NOT NULL,
//   PRIMARY KEY (source, field)
// );
const db = new Pool();
const isDev = process.env.NODE_ENV === "development";

type ExtraField = { path: string; type: string; sample: string };

// Posts { text } to a webhook: Slack as is, Discord with /slack at the end of the URL
const sendAlert = async (text: string): Promise<void> => {
  const res = await fetch(process.env.ALERT_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5_000), // a slow webhook must not stall the pipeline
  });
  if (!res.ok) throw new Error(`alert rejected: ${res.status}`);
};

// "string", "number[]", "(string | null)[]"…
const describeType = (value: unknown): string => {
  if (value === null) return "null";
  if (!Array.isArray(value)) return typeof value;
  const types = [...new Set(value.map(describeType))];
  if (types.length === 0) return "unknown[]";
  return types.length === 1 ? `${types[0]}[]` : `(${types.join(" | ")})[]`;
};

// A short sample of the value, to update the schema without digging up the data
const sampleOf = (value: unknown): string => {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
};

// Zod 4 internals (_def) are neither public nor typed: pin your Zod version
const defOf = (schema: z.ZodType): any => (schema as any)._def;

// Strips optional, nullable, default, lazy, transform… to reach the real schema
const unwrap = (schema: z.ZodType): z.ZodType => {
  for (;;) {
    const def = defOf(schema);
    if (def.innerType) schema = def.innerType;
    else if (def.type === "lazy") schema = def.getter();
    // .transform(): the data has the input's shape. z.preprocess(): the output's.
    else if (def.type === "pipe")
      schema = defOf(def.in).type === "transform" ? def.out : def.in;
    else return schema;
  }
};

// Walks the schema and the data side by side.
// Not handled: tuples (skipped) and looseObject (its extra fields are reported).
export const findExtraFields = (
  schema: z.ZodType,
  value: unknown,
  path: string[] = [],
): ExtraField[] => {
  const def = defOf(unwrap(schema));

  // Union: among the options that accept the data, keep the one that knows the most fields
  if (def.type === "union") {
    const options: z.ZodType[] = def.options;
    const valid = options.filter((option) => option.safeParse(value).success);
    return (valid.length > 0 ? valid : options)
      .map((option) => findExtraFields(option, value, path))
      .reduce((best, extras) => (extras.length < best.length ? extras : best));
  }

  // Intersection (.and): a field is extra only if both sides say so
  if (def.type === "intersection") {
    const right = findExtraFields(def.right, value, path).map((f) => f.path);
    return findExtraFields(def.left, value, path).filter((f) =>
      right.includes(f.path),
    );
  }

  // Arrays and records: go down without putting the index or the key in the path
  if (Array.isArray(value))
    return def.type === "array"
      ? value.flatMap((item) => findExtraFields(def.element, item, path))
      : [];
  if (typeof value !== "object" || value === null) return [];
  if (def.type === "record")
    return Object.values(value).flatMap((item) =>
      findExtraFields(def.valueType, item, path),
    );
  if (def.type !== "object") return [];

  // Object.hasOwn, not `in`: otherwise a "constructor" field looks known
  return Object.entries(value).flatMap(([key, child]) =>
    Object.hasOwn(def.shape, key)
      ? findExtraFields(def.shape[key], child, [...path, key])
      : [
          {
            path: [...path, key].join("."),
            type: describeType(child),
            sample: sampleOf(child),
          },
        ],
  );
};

// Unknown fields: one alert per field, even across several jobs
const knownFields = new Set<string>(); // avoids a database write for every item

const alertNewFields = async (
  source: string,
  extras: ExtraField[],
): Promise<void> => {
  const fresh: ExtraField[] = [];
  for (const field of extras) {
    const key = `${source}:${field.path}`;
    if (knownFields.has(key)) continue;
    knownFields.add(key); // before the await: two items in parallel, still one alert
    try {
      // 0 rows inserted = field already reported by another job
      const { rowCount } = await db.query(
        "INSERT INTO known_fields (source, field) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [source, field.path],
      );
      if (rowCount === 0) continue;
    } catch (err) {
      // Better a duplicate alert than a lost one
      console.error("database unavailable, alerting anyway", err);
    }
    fresh.push(field);
  }
  if (fresh.length === 0) return;

  const lines = fresh.map((f) => `• ${f.path}: ${f.type} (e.g. ${f.sample})`);
  try {
    await sendAlert(`[${source}] new fields:\n${lines.join("\n")}`);
  } catch (err) {
    console.error("alert not sent", err);
    // Forget these fields in the database: another job, or the next run, will alert again
    const paths = fresh.map((f) => f.path);
    await db
      .query("DELETE FROM known_fields WHERE source = $1 AND field = ANY($2)", [
        source,
        paths,
      ])
      .catch(() => {});
  }
};

// Invalid data: one alert per failing field, per process
const alertedErrors = new Set<string>();

const alertInvalid = async (
  source: string,
  error: z.ZodError,
): Promise<void> => {
  const fresh: string[] = [];
  for (const issue of error.issues) {
    // No indexes: items.0.price and items.1.price give the same key
    const field = issue.path
      .filter((key) => typeof key !== "number")
      .map(String)
      .join(".");
    const key = `${source}:${issue.code}:${field}`;
    if (alertedErrors.has(key)) continue;
    alertedErrors.add(key);
    fresh.push(`• ${field || "(root)"}: ${issue.message}`);
  }
  if (fresh.length === 0) return;
  await sendAlert(`[${source}] invalid data:\n${fresh.join("\n")}`).catch(
    (err) => console.error("alert not sent", err),
  );
};

/**
 * true: the item moves on. false: it goes to the error queue.
 * In production, an extra field lets the item through and triggers an alert.
 * In development, it blocks the item like a strict schema, and nothing reaches the webhook.
 */
export const validate = async (
  source: string,
  schema: z.ZodType,
  value: unknown,
): Promise<boolean> => {
  const result = schema.safeParse(value);
  const extras = findExtraFields(schema, value);

  if (isDev) {
    if (!result.success) console.warn(z.prettifyError(result.error));
    if (extras.length > 0) console.warn(`[${source}] unknown fields`, extras);
    return result.success && extras.length === 0;
  }

  if (!result.success) await alertInvalid(source, result.error);
  await alertNewFields(source, extras);
  return result.success;
};
