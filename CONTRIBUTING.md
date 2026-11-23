# Contributing

Thanks for taking the time. Issues and pull requests are welcome, in English or French.

## Reporting a bug

Open an issue with:

- the Zod version you use (`yarn why zod`),
- a minimal schema and a sample of the data,
- what `findExtraFields` or `validate` returned, and what you expected.

A failing test in `validate.test.ts` is the best bug report.

## Before a pull request

- For a change in behaviour (alert format, dev/prod policy, deduplication), open an issue first. The code follows a published article, so these choices are deliberate.
- Keep the runtime dependencies to `zod` and `pg`. No new package in `dependencies`.
- Add a test for what you change.
- Run `yarn verify` (typecheck + tests). CI runs it on Node 20, 22 and 24.

## Supporting a new Zod version

`validate.ts` reads Zod internals (`_def`). If a Zod update breaks it, a pull request that bumps the pinned version in `package.json` and fixes `unwrap` or `findExtraFields` is very welcome.

## Licence

By contributing, you agree that your contribution is released under the [MIT License](LICENSE).
