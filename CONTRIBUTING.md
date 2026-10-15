# Contributing

Thanks for helping. Bug reports with a way to reproduce them are the most
useful thing you can send: the command you ran (with the password removed),
the `pg_dump`, `pg_restore` and server versions, and the output.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` builds the CLI first, then runs three suites:

- `test/unit.test.ts` and `test/cli.test.ts` need nothing but Node.
- `test/integration.test.ts` needs `psql` and `pg_dump` on PATH and a Postgres
  to work against. By default it starts its own throwaway container
  (`pgbv-test-<random>`, on a port Docker picks) and removes it afterwards. The
  image matches the major version of your local `pg_dump`
  (`postgres:<major>-alpine`), because `pg_dump` refuses a newer server; set
  `PGBV_TEST_IMAGE` to choose another. To use a server you already run, set
  `PGBV_TEST_URL` to a superuser URL on a server you do not mind tests creating
  and dropping databases on; never point it at one that holds real data. With
  neither Docker nor `PGBV_TEST_URL`, the integration tests are skipped with a
  message.

## Pull requests

- Keep changes focused, with a test for any behavior change.
- No new runtime dependencies without a reason good enough to state in the
  README's "How it works".
- American English in code, docs and messages.
- Update `CHANGELOG.md` under "Unreleased".
