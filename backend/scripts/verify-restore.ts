/**
 * Prove that a restored database is the database that was backed up.
 *
 *   DATABASE_URL=<the restored target> npx tsx scripts/verify-restore.ts --manifest ./restore/manifest.json
 *
 * This is the half of "untested backups" that the dump script cannot do for
 * itself. A dump that uploads cleanly, is the right size, and restores without
 * an error can still be missing a table, be a schema the running code cannot
 * read, or be a snapshot of the wrong database. So the checks here are the ones
 * that fail in those three ways specifically:
 *
 *  - Row counts, per table, against the counts taken at dump time. The
 *    comparison is >= rather than ==, because backup-db.sh counts before
 *    pg_dump starts: a row written while the dump ran is legitimately in the
 *    restore and not in the manifest. Short is the direction that means data
 *    was lost, and short is what fails here. Any drift is printed either way,
 *    since drift at 4am on a single-course instance should be zero and a
 *    non-zero number is worth seeing.
 *  - Migration history, against the migrations in this checkout. A restore
 *    carrying a migration this code has never heard of is a backup from a
 *    future or a foreign database. The reverse — the checkout being ahead — is
 *    normal between writing a migration and deploying it, so it only warns.
 *  - One real query through the Prisma client, with relations. Raw counts go
 *    through SQL and would not notice a restore whose column names or types no
 *    longer match what the generated client expects; this would.
 *
 * Exits non-zero on any failure, which is what makes the monthly drill mean
 * something.
 */

import 'dotenv/config'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '../src/db/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

interface Manifest {
  takenAt: string
  object: string
  artifactBytes: number
  artifactSha256: string
  gitSha: string
  sourceVersion: string
  rowCounts: Record<string, number>
}

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`)
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** The same exact-count pass backup-db.sh takes, so the two are comparable. */
async function liveCounts(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRawUnsafe<{ relname: string; cnt: bigint }[]>(`
    SELECT c.relname,
           (xpath('/row/c/text()',
                  query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                               false, true, '')))[1]::text::bigint AS cnt
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = 'public'
  `)
  return Object.fromEntries(rows.map((r) => [r.relname, Number(r.cnt)]))
}

function repoMigrations(): string[] {
  return readdirSync(join(HERE, '..', 'prisma', 'migrations'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

async function main() {
  const manifestPath = arg('manifest')
  if (!manifestPath) {
    console.error('Usage: DATABASE_URL=<target> npx tsx scripts/verify-restore.ts --manifest <path>')
    process.exit(1)
  }

  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  console.log(`Backup taken ${manifest.takenAt} from ${manifest.sourceVersion.split(',')[0]}`)
  console.log(
    `Artifact ${manifest.object} — ${manifest.artifactBytes} bytes, sha256 ${manifest.artifactSha256.slice(0, 12)}, code ${manifest.gitSha}`,
  )

  section('Tables and row counts')
  const live = await liveCounts()
  const recorded = manifest.rowCounts
  const recordedTables = Object.keys(recorded).sort()

  check('the manifest recorded at least one table', recordedTables.length > 0)

  let drift = 0
  for (const table of recordedTables) {
    const want = recorded[table]
    const got = live[table]
    if (got === undefined) {
      check(`${table} exists`, false, 'table missing from the restored database')
      continue
    }
    if (got !== want) drift++
    check(
      `${table}: ${got} rows`,
      got >= want,
      got >= want ? undefined : `expected at least ${want}, short by ${want - got}`,
    )
  }

  const extra = Object.keys(live).filter((t) => !(t in recorded))
  if (extra.length > 0) {
    console.log(`  note  restored database has tables the manifest does not: ${extra.join(', ')}`)
  }
  if (drift > 0) {
    console.log(
      `  note  ${drift} table(s) hold more rows than the manifest — writes during the dump. Expect zero on an idle instance.`,
    )
  }

  section('Migration history')
  const applied = await prisma
    .$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name`,
    )
    .catch(() => null)

  if (applied === null) {
    check('_prisma_migrations survived the restore', false, 'table missing or unreadable')
  } else {
    check('_prisma_migrations survived the restore', applied.length > 0, `${applied.length} applied`)
    const repo = repoMigrations()
    const unknown = applied.map((m) => m.migration_name).filter((n) => !repo.includes(n))
    check('every applied migration exists in this checkout', unknown.length === 0, unknown.join(', '))
    const undeployed = repo.filter((n) => !applied.some((m) => m.migration_name === n))
    if (undeployed.length > 0) {
      console.log(`  note  this checkout has ${undeployed.length} migration(s) the backup predates: ${undeployed.join(', ')}`)
    }
  }

  section('The restored schema is one the code can read')
  // Raw SQL would not notice a column the generated client no longer matches.
  // A relation-loading query would, and it is the shape the app actually issues.
  if ((recorded.Response ?? 0) > 0) {
    const response = await prisma.response
      .findFirst({ include: { question: true, student: true } })
      .catch((err: unknown) => {
        check('a response loads with its question and student', false, String(err).slice(0, 200))
        return null
      })
    if (response !== null) {
      check('a response loads with its question and student', !!response?.question && !!response?.student)
    }
  } else {
    console.log('  skip  no responses in the backup to load')
  }

  const professors = await prisma.professor.count()
  check(
    'professors are readable through the client',
    professors >= (recorded.Professor ?? 0),
    `${professors} readable, manifest recorded ${recorded.Professor ?? 0}`,
  )

  const newest = await prisma.response.findFirst({
    orderBy: { submittedAt: 'desc' },
    select: { submittedAt: true },
  })
  if (newest) {
    const ageDays = (Date.now() - newest.submittedAt.getTime()) / 86_400_000
    console.log(`  note  newest answer in the restore is ${ageDays.toFixed(1)} days old`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error('FATAL:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
