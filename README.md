# zod-schema-drift

[![test](https://github.com/JKS9/zod-schema-drift/actions/workflows/test.yml/badge.svg)](https://github.com/JKS9/zod-schema-drift/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Strict, but not too strict: know when an API adds a field.

Zod tells you when a field is missing. It never tells you when one appears: by default, `z.object()` accepts unknown keys and silently strips them. A new field is often the first sign that an API you don't control has changed.

`validate()` lets the data through **and** sends one alert per new field, with its full path, its type and a sample value:

```
[products-api] new fields:
• ingredients.origin: string (e.g. "USA")
• nutrients.per_serving: number (e.g. 2.5)
• allergens: string[] (e.g. ["gluten","milk"])
```

<!-- TODO: link the article once it is published -->

## Why not `.strict()` or `z.looseObject()`?

| Approach | New field in the API response |
| --- | --- |
| `z.object()` (default) | Validation passes, field stripped, nobody knows |
| `z.strictObject()` / `.strict()` | Validation fails, the whole source goes to the error queue |
| `z.looseObject()` / `.passthrough()` | Field kept, nobody knows |
| **`validate()`** | **Data goes through, one alert with path, type and sample** |

## Getting started

This is not an npm package, on purpose. It is one file of about 200 lines, and you will likely want to adapt the alert format or the storage. Copy [`validate.ts`](validate.ts) into your project.

### Requirements

- Node.js 20 or later
- Zod 4, **pinned to an exact version** (see [Limitations](#limitations))
- PostgreSQL, to remember which fields were already reported
- A webhook that accepts `{ "text": "..." }`

```bash
yarn add --exact zod@4.6.7
yarn add pg
```

### Create the table

```sql
CREATE TABLE known_fields (
  source text NOT NULL,
  field  text NOT NULL,
  PRIMARY KEY (source, field)
);
```

### Environment variables

| Variable | Used for |
| --- | --- |
| `ALERT_WEBHOOK_URL` | Where alerts are posted |
| `NODE_ENV` | `development` turns on strict mode (see below) |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Read by `new Pool()` from [`pg`](https://node-postgres.com/features/connecting) |

The alert is sent as `{ "text": "..." }`, the format of Slack incoming webhooks:

- **Slack**: use your incoming webhook URL as is.
- **Discord**: Discord also accepts this format on its Slack-compatible endpoint. Take your Discord webhook URL and add `/slack` at the end: `https://discord.com/api/webhooks/<id>/<token>/slack`.
- **Anything else**: change the body in `sendAlert`.

### Usage

```ts
import { z } from "zod";
import { validate } from "./validate";

const productSchema = z.object({
  barcode: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  ingredients: z.array(
    z.object({ name: z.string(), percent: z.number().optional() }),
  ),
  nutrients: z.record(
    z.string(),
    z.object({ value: z.number(), unit: z.string() }),
  ),
});

// Pass the raw data on, not result.data: Zod has stripped the unknown fields
if (await validate("products-api", productSchema, product)) await save(product);
else await sendToErrorQueue(product);
```

The first argument names the source. Alerts are deduplicated per source and per field.

## Development vs production

| | Production | Development (`NODE_ENV=development`) |
| --- | --- | --- |
| Unknown field | `true`, one alert per field | `false`, warning in the console |
| Invalid data | `false`, one alert per failing field | `false`, warning in the console |
| Webhook and database | Used | Never touched |

Strict while you write a scraper, so you see right away what your schema misses. Tolerant once it runs, so a harmless new field doesn't stop the pipeline.

## How it works

- **Walks the schema and the data side by side.** It unwraps `optional`, `nullable`, `default`, `lazy`, `.transform()` and `z.preprocess()`, then goes into objects, arrays, records, unions and intersections.
- **No indexes in paths.** `ingredients.0.origin` and `ingredients.1.origin` both become `ingredients.origin`, reported once.
- **`Object.hasOwn`, not `in`.** A field named `constructor` or `toString` is still reported as new.
- **One alert per field, even across jobs.** An in-memory `Set` avoids a database write per item. Then `INSERT ... ON CONFLICT DO NOTHING` lets only one job win and send the alert.
- **Failures fall on the safe side.** Database down: the alert is sent anyway (a duplicate beats a lost alert). Webhook down: the field is removed from the table, so another job or the next run alerts again. The webhook has a 5-second timeout, so a slow service cannot stall the pipeline.
- **Invalid data:** one alert per failing field and per process, without array indexes.

## Limitations

- It reads Zod internals (`_def`), which are not part of the public API. An update can change them: pin your Zod version and keep the tests.
- Tuples are skipped. Extra fields of a `z.looseObject()` are reported even though the schema accepts them.
- The type shown is the one of the first value seen. If the field is sometimes `null`, the alert may not say so.
- Deduplication uses Postgres, but any store that can insert a key only if it doesn't exist works, Redis `SET NX` for example.

## Running the tests

```bash
yarn install
yarn test          # node:test through tsx, Postgres and the webhook are mocked
yarn verify        # typecheck + tests
```

No database or webhook needed: both are mocked.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). You can use, copy, modify and ship this code, including in commercial projects, as long as the copyright notice stays in the copied file or alongside it.
