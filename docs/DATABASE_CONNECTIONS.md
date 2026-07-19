# DATABASE_CONNECTIONS.md — serverless Postgres connection handling

**Written after a production incident**, not in advance of one.

## The incident

Netlify function log:

```
prisma:error  Error in PostgreSQL connection: Error { kind: Closed, cause: None }
```

The CallGrid reconciliation route failed on its FIRST database call — the `can()`
permission check — before CallGrid was ever contacted.

## What `kind: Closed` means, and what it rules out

It is the Prisma query engine reporting that the socket to Postgres was **already
closed** when a query was issued. The connection existed, then went away beneath a
client that still believed it was live.

That single detail eliminates most candidates:

| Hypothesis | Verdict | Why |
|---|---|---|
| `DATABASE_URL` missing in the deploy context | **Ruled out** | A missing variable raises `PrismaClientInitializationError: Environment variable not found`, not a connection error. `kind: Closed` proves the URL was present and parseable. |
| Premature `$disconnect()` in a request | **Ruled out** | The only `$disconnect()` in the repository is in `prisma/seed.ts`, a script that never runs in a request. |
| A `finally` block disconnecting | **Ruled out** | No such block exists. |
| Multiple PrismaClient instances | **Ruled out** | Exactly one `new PrismaClient` exists, in `packages/database/src/index.ts`. |
| Migration state drift | **Not implicated** | Schema drift produces `P2021`/`P2022` (table or column missing), not a closed socket. |

## Root cause

`prisma` is a **module-scoped singleton**. A Netlify function container stays warm
across invocations, so that client — and the TCP socket it holds — outlives a
single request.

Neon suspends an idle compute after a few minutes and drops its connections. The
next invocation reuses the warm container, issues a query on the now-dead socket,
and fails immediately with `kind: Closed`.

This is why the failure appears on the first database call regardless of what the
route does afterwards.

## The fix, in two parts

### 1. Code — recover from a dropped socket (shipped)

`packages/database/src/connection-resilience.ts` + a client extension in
`index.ts`. Every operation retries **once**, and **only** on connection loss:
disconnect the dead socket, reconnect, reissue the query.

Deliberately narrow and non-looping. Retrying a constraint violation would hide a
real bug; retrying forever would turn an outage into a pile-up. Both properties
are asserted in `test/connection-resilience.test.ts`.

Applied once at the client rather than per route — a per-route guard would leave
every other route exposed to the identical failure.

### 2. Configuration — stop holding raw sockets (requires Netlify access)

The code fix makes the platform survive suspension. It does not remove the cause.

- **`DATABASE_URL` should be Neon's POOLED endpoint** — the host containing
  `-pooler`. The pooler absorbs compute suspension so individual containers never
  hold a raw connection to the compute.
- Recommended parameters: `?sslmode=require&pgbouncer=true&connection_limit=1`.
  `connection_limit=1` is correct for serverless: many short-lived containers, one
  connection each, pooled upstream.
- **Verify `DATABASE_URL` is present in the Deploy Preview context**, not only in
  Production. Deploy Previews do not inherit production variables unless
  configured to.

### Not done deliberately: `directUrl`

Prisma's `directUrl` (for migrations bypassing the pooler) was **not** added to the
datasource. `.env.example` defines `DIRECT_DATABASE_URL`, but the schema has never
referenced it, and Prisma validates datasource env vars at `generate` time — so
adding it while the variable is absent from Netlify would fail `prisma generate`
and break the entire production build.

Add it only after confirming `DIRECT_DATABASE_URL` exists in every build context.
