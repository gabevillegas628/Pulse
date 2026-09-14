# Prisma 7 Migration Plan

Scheduled for winter break, when nobody is running a class and a broken deploy costs
nothing. Written 2026-09-04 against Prisma 6.19.3, which is what `backend/` runs today.

The whole job is a client-layer migration. **No schema change, no database migration,
no data movement.** Every one of the 25 migrations in `backend/prisma/migrations/`
stays exactly as it is, and the production database is never touched by this work.
That is the single fact that makes this safe enough to do in one sitting: the rollback
is `git revert` and `npm ci`, not a restore.

---

## Status Legend
- [ ] Pending
- [~] In progress
- [x] Done

---

## 1. Target version — and the trap in `@latest`

**Install `prisma@7.10.x` and `@prisma/client@7.10.x` explicitly. Do not run
`npm install prisma@latest`.**

As of 2026-09-04 the npm `latest` dist-tag on `prisma` points at `8.0.0-rc.13`, a
release candidate. The last stable 7.x is **7.10.0** (published 2026-08-25), which npm
carries under the `prev` tag. `npm install prisma@latest` today installs an RC into
the app that runs live lectures. Pin the version numbers by hand, and re-check the tags
on the day — if 8.0.0 has gone stable by December, `latest` will mean something
different again, and it still won't be what this plan targets.

### Why not go straight to Prisma 8

Prisma 8 is not "7 plus fixes". It introduces contract-based data models, a TypeScript
runtime, and a new query API; it removes the legacy `@db.*` attributes and moves
PostgreSQL temporal columns off `Date` onto explicit Temporal-or-text representations.
That is a rewrite of the data layer, not an upgrade, and it is the wrong shape for a
fixed window over a break.

Go to 7.10.x now. Revisit 8 as its own project once it has been stable for a few
months and the migration guide has been through some real-world contact.

---

## 2. What actually changes (and what doesn't)

Prisma 7's headline change is that the Rust query engine is gone. The client is
generated as TypeScript into your own source tree and talks to the database through an
explicit driver adapter — for us, `@prisma/adapter-pg` over `node-pg`. The knock-on
effects are all configuration, not query code.

| Change in v7 | Our exposure |
|---|---|
| `prisma-client-js` → `prisma-client` generator | 1 line in `schema.prisma` |
| Generated client output path now required, not `node_modules` | new dir + `.gitignore` + build check |
| Driver adapter mandatory; `new PrismaClient()` alone throws | 1 file: `backend/src/db/index.ts` |
| `datasource.url` no longer read from `schema.prisma` | moves to a new `prisma.config.ts` |
| CLI no longer auto-loads env vars | `import "dotenv/config"` in the config file |
| `package.json` `prisma.seed` block removed | moves to `prisma.config.ts` |
| Client middleware (`$use`) removed | **none** — we never used it |
| Metrics preview feature removed | **none** — never enabled |
| `prisma generate` no longer runs on postinstall or inside `migrate dev` | our build already calls it explicitly |
| Auto-seeding removed; `--skip-generate` / `--skip-seed` flags gone | check scripts for those flags (none today) |
| MongoDB unsupported in v7 | irrelevant — we're PostgreSQL |
| Node >= 20.19.0, TypeScript >= 5.4.0 | already satisfied: Node 22.16, TS 5.7 |

The query code itself does not change. `findMany`, `include`, `select`, `$transaction`,
`$queryRaw`, `Prisma.sql`, `Prisma.join` and `PrismaClientKnownRequestError` all keep
their shapes — only where you *import* them from moves.

### The blast radius is small, and that is not luck

Every runtime consumer of the client goes through the singleton in
`backend/src/db/index.ts` — 29 files import `{ prisma }` from there, including all nine
scripts in `backend/scripts/`. Only **eight** files reach into `@prisma/client`
directly, and most of those want types:

- `backend/prisma/seed.ts` — `PrismaClient` (value; constructs its own)
- `backend/src/db/index.ts` — `PrismaClient` (value; the singleton)
- `backend/src/middleware/error.middleware.ts` — `Prisma` (value; `PrismaClientKnownRequestError`)
- `backend/src/routes/assignments.routes.ts` — `Prisma` (value; `sql`, `join`)
- `backend/src/routes/classes.routes.ts` — `Prisma` (value; `sql`, `join`)
- `backend/src/routes/sessions.routes.ts` — `Prisma` (value; `sql`, `join`)
- `backend/src/routes/admin.routes.ts` — `Prisma` (type only)
- `backend/src/middleware/auth.middleware.ts` — `Professor`, `Student` (types only)
- `backend/src/utils/ownership.ts` — `Prisma`, `Professor` (types only)

Plus two inline `import('@prisma/client').QuestionType` casts in
`backend/src/routes/questions.routes.ts` (lines 91 and 471).

`shared/`, `frontend/` and `addin/` do not touch Prisma at all. This is a
backend-only change.

---

## 3. Phases

Each phase is a commit that can stand alone. Phases 1–5 leave the tree broken in the
middle — that's expected and fine on a branch — but the phase boundaries are where you
stop and think, not where you deploy.

### Phase 0 — Spike, before the break

Do this in an hour some evening in November, on a throwaway branch you delete
afterwards. The point is to convert the three open questions below into answers, so
that the December session is execution rather than discovery.

- [ ] Branch `spike/prisma-7`, upgrade the packages, get `npm run build` green
- [ ] **Q1: does `tsc` alone produce a working `dist/`?** The generator emits into our
      source tree and `backend/tsconfig.json` has `rootDir: ./src`, so output under
      `src/generated/prisma` gets compiled along with everything else. If the generator
      also emits non-TypeScript assets (`.wasm` for the query compiler, `.json`), `tsc`
      will not copy them and `npm start` will fail on a file that exists in `src` but
      not `dist`. Answer by generating and running `ls -R backend/src/generated/prisma`,
      then `npm run build && npm start` against the dev database. If assets need
      copying, decide the fix now: a `copyfiles` step in the build script, or generate
      outside `rootDir` and add a path mapping.
- [ ] **Q2: does the Railway connection string survive stricter SSL?** v6's Rust engine
      ignored invalid SSL certificates; `node-pg` does not. Point the spike at the
      Railway dev clone using the *same* URL shape production uses and see whether it
      connects. If it fails, the fix is `ssl` options on the `PrismaPg` constructor —
      but find that out in November, not on the deploy.
- [ ] **Q3: `moduleFormat` / `importFileExtension`.** The backend is `"type": "module"`
      with `moduleResolution: NodeNext`, which requires explicit `.js` extensions on
      relative imports. The generator has `moduleFormat` and `importFileExtension`
      options for exactly this. Confirm the combination that typechecks, and write the
      generator block down in this document before closing the spike.
- [ ] Record all three answers in this file, delete the branch

### Phase 1 — Packages

- [ ] `backend/package.json`: `prisma` and `@prisma/client` → `7.10.x` (pinned, no `^` until it's proven)
- [ ] Add `@prisma/adapter-pg` at the matching version (7.10.0 exists)
- [ ] Add `pg` explicitly if the adapter declares it a peer dependency rather than bundling it
- [ ] `npm install` from the repo root — this is a workspace, never install inside `backend/`
- [ ] Confirm `package-lock.json` shows no stray v6 remnants

### Phase 2 — Configuration

- [ ] Create `backend/prisma.config.ts`. It must live in the directory the CLI runs
      from, and every `db:*` script runs in the `backend` workspace, so it is
      `backend/prisma.config.ts` — not the repo root.

  ```ts
  import 'dotenv/config'
  import { defineConfig, env } from 'prisma/config'

  export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: {
      path: 'prisma/migrations',
      seed: 'tsx prisma/seed.ts',
    },
    datasource: {
      url: env('DATABASE_URL'),
    },
  })
  ```

- [ ] Delete the `"prisma": { "seed": ... }` block from `backend/package.json` — it now
      lives in `migrations.seed` above, and leaving both is a silent conflict
- [ ] `backend/prisma/schema.prisma`, generator block:

  ```prisma
  generator client {
    provider = "prisma-client"
    output   = "../src/generated/prisma"
    runtime  = "nodejs"
    // moduleFormat / importFileExtension per the Phase 0 spike
  }
  ```

- [ ] `backend/prisma/schema.prisma`, datasource block: drop `url = env("DATABASE_URL")`,
      leaving only `provider = "postgresql"`. The URL is read from `prisma.config.ts` now.
- [ ] `.gitignore`: add `backend/src/generated/`. The client is a build artefact; it is
      regenerated by `npm run build` on CI and on Railway, and committing several
      thousand generated lines would make every schema change unreviewable.

### Phase 3 — Client construction

- [ ] Rewrite `backend/src/db/index.ts`:

  ```ts
  import { PrismaClient } from '../generated/prisma/client.js'
  import { PrismaPg } from '@prisma/adapter-pg'

  const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })

  export const prisma =
    globalForPrisma.prisma ?? new PrismaClient({ adapter, log: ['error'] })

  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
  ```

  Keep the `globalThis` singleton exactly as it is — `tsx watch` still reloads the
  module on every save in dev, and without it each reload opens a new pool.

- [ ] **Review the connection pool defaults.** v6 used a 5-second connection timeout;
      the `pg` driver defaults to no timeout (0). A database that is slow or briefly
      unreachable now produces a request that hangs instead of one that fails, which
      during a live session is worse. Set an explicit `connectionTimeoutMillis` and a
      `max` pool size on the adapter rather than inheriting whatever the driver picks.
- [ ] Apply the SSL configuration determined in Phase 0 Q2, if any
- [ ] `backend/prisma/seed.ts` constructs its own `PrismaClient` — give it the adapter too
- [ ] Check the SIGTERM/SIGINT shutdown path still closes the client cleanly; the pool is
      the adapter's now, not the engine's

### Phase 4 — Imports

- [ ] Add a types re-export so the ten import sites become one. Put it next to the
      singleton, e.g. `backend/src/db/prisma.ts` re-exporting `Prisma`, `Professor`,
      `Student`, `QuestionType` and friends from the generated path. The next time
      Prisma moves the output — and Prisma 8 will move something — that is one file to
      edit instead of ten.
- [ ] Update the eight `@prisma/client` importers listed in §2
- [ ] Replace the two inline `import('@prisma/client').QuestionType` casts in
      `backend/src/routes/questions.routes.ts` (lines 91, 471)
- [ ] `grep -rn "@prisma/client" backend/src backend/scripts backend/prisma` returns nothing

### Phase 5 — Build and deploy

- [ ] `npm run build` from the root, green across all four workspaces
- [ ] Confirm `backend/dist/` contains a runnable client (the Phase 0 Q1 answer)
- [ ] `railway.toml` needs no change in principle: `startCommand` runs
      `npm run db:migrate:deploy && npm start`, and the root script delegates into the
      `backend` workspace, so `prisma.config.ts` resolves from the right directory.
      **Verify this rather than assume it** — a config file the CLI cannot find at deploy
      time fails at migrate, after the old container has already been replaced.
- [ ] `.github/workflows/ci.yml` needs no change: it sets `DATABASE_URL` in the job
      environment, `prisma.config.ts` reads it through `env()`, and `npm run build`
      already calls `prisma generate` explicitly rather than relying on the postinstall
      hook that v7 removed. Confirm the run is green anyway.

### Phase 6 — Verification

Against the Railway dev clone, never production. All four integration suites pass
against it today, which is the baseline to match.

- [ ] `npm run test:clock` — the autoclose clock, no database
- [ ] `npm run test:smoke:socket --workspace=backend`
- [ ] `npm run test:smoke:admin --workspace=backend` — exercises the `$queryRaw` in `admin.routes.ts`
- [ ] `npm run test:smoke:autoclose --workspace=backend`
- [ ] `npm run test:smoke:reset --workspace=backend`
- [ ] `npm run test:smoke:themes --workspace=backend` — costs real Anthropic tokens; run it once, last
- [ ] `npm run test:e2e:qr --workspace=backend`
- [ ] `npm run rehearse` end to end
- [ ] `GET /health` returns healthy — it runs a raw `SELECT 1` at `backend/src/app.ts:138`
- [ ] `npm run db:migrate:deploy` against the dev clone reports no pending migrations —
      proof the migration history still reads correctly under the new CLI
- [ ] Deploy to Railway, watch the first real request, keep the previous deploy pinned
      for an hour

Targeted checks beyond the suites are listed in §4.

---

## 4. Risk register

### R1 — Raw query return types change shape under `node-pg` · likely · medium

The one place where v7 can change *runtime behaviour* rather than just wiring. The Rust
engine and `node-pg` parse PostgreSQL types differently: `node-pg` returns `int8` (what
`COUNT(*)` produces) and `numeric` as **strings**, where the Rust engine returned
`BigInt`. The four raw queries:

- `backend/src/routes/admin.routes.ts:82` — casts `COUNT(*)::int`, typed `number`. Safe.
- `backend/src/routes/assignments.routes.ts:67` — `COUNT(DISTINCT ...)`, typed `bigint`,
  consumed as `Number(row.respondentCount)`. The `Number()` call absorbs a string, so it
  keeps working — but the TypeScript annotation becomes a lie. **Retype to `string`.**
- `backend/src/routes/sessions.routes.ts:88` — same pattern, same fix.
- `backend/src/routes/classes.routes.ts:83` — `AVG(sub.respondents::float / ...)`. The
  `::float` cast makes this `float8`, which `node-pg` does parse to a number, and it is
  read through `Number()` anyway. Safe — but it is safe by accident, so verify it.

Mitigation: the admin and assignments paths are covered by `test:smoke:admin`; check the
class-list participation rate and the assignment respondent counts **by eye in the UI**
after migrating, because a `"12"` where a `12` was expected renders identically in some
places and concatenates in others.

### R2 — Generated client assets missing from `dist/` · possible · high

Covered by Phase 0 Q1. High impact because it fails at `npm start` on Railway, after the
build reported success. Resolve in the spike.

### R3 — SSL rejection against Railway · possible · high

Covered by Phase 0 Q2. Same failure mode: everything builds, nothing connects.

### R4 — `prisma.config.ts` not found at deploy time · possible · high

The deploy runs `db:migrate:deploy` before `start`. If the CLI cannot find the config it
cannot find the datasource URL, and the deploy fails at migrate — after the old
container is gone. Covered in Phase 5; test by running the exact `startCommand` string
locally against the dev clone.

### R5 — `dotenv` no longer implicit · likely · low

v7's CLI does not load `.env`. `dotenv` is already a backend dependency and every script
already does `import 'dotenv/config'`, so the only gap is `prisma.config.ts` itself,
which the Phase 2 snippet handles. Low impact, but it fails confusingly — an empty
`DATABASE_URL` reads as a connection error, not a missing file.

### R6 — Scope creep into Prisma 8 · likely · medium

The temptation, mid-migration, will be "8.0 is stable now, do both". Don't. Different
project, different risk profile, §1 explains why. If 8.0 has shipped by December, that
is a reason to write the version numbers down more carefully, not a reason to change
target.

---

## 5. Rollback

Do the work on a branch (`chore/prisma-7`), one commit per phase, and merge only after
Phase 6 is fully green.

If something surfaces after deploy:

1. Redeploy the previous Railway build. It is a self-contained image and does not depend
   on anything this branch changed.
2. `git revert` the merge, `npm ci` from the root, `npm run build`.

There is nothing else to undo. No migration ran, no column moved, no row changed — the
database is bit-identical either side of this work, and a v6 client and a v7 client read
the same schema. That property holds only as long as this migration stays free of schema
changes, which is why anything schema-shaped that comes up during the work goes on the
backlog instead of into the branch.

---

## 6. Estimate

Phase 0 spike: about an hour, some evening in November.
Phases 1–6: half a day if the spike answered its three questions, a full day if not.

The long pole is Phase 6, not the code. The code is roughly ten files.

---

## Sources

- [Upgrade to Prisma ORM 7](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)
- [Prisma ORM v7.0.0: Rust-free Prisma Client becomes the default](https://www.prisma.io/changelog/2025-11-19)
- [Prisma config reference](https://www.prisma.io/docs/orm/reference/prisma-config-reference)
- [The Next Evolution of Prisma ORM (Prisma 8)](https://www.prisma.io/blog/the-next-evolution-of-prisma-orm)
