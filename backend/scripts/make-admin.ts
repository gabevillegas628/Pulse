/**
 * Grant or revoke the admin bit on a professor account.
 *
 * Deliberately a script and not a screen: no UI grants admin, so minting one
 * requires database access, which for a single instance is the honest answer to
 * "who admins the admins" — the operator does.
 *
 * Usage:
 *   npx tsx scripts/make-admin.ts someone@rutgers.edu
 *   npx tsx scripts/make-admin.ts someone@rutgers.edu --revoke
 */

import 'dotenv/config'
import { prisma } from '../src/db/index.js'

async function main() {
  const email = process.argv[2]
  const revoke = process.argv.includes('--revoke')

  if (!email || email.startsWith('--')) {
    console.error('Usage: npx tsx scripts/make-admin.ts <email> [--revoke]')
    process.exit(1)
  }

  const professor = await prisma.professor.findUnique({ where: { email } })
  if (!professor) {
    console.error(`No professor account with email ${email}`)
    process.exit(1)
  }

  if (professor.isAdmin === !revoke) {
    console.log(`${professor.name} <${professor.email}> already has isAdmin=${professor.isAdmin} — nothing to do`)
    return
  }

  const updated = await prisma.professor.update({
    where: { email },
    data: { isAdmin: !revoke },
  })
  console.log(`${updated.name} <${updated.email}> — isAdmin is now ${updated.isAdmin}`)
}

main()
  .catch((err) => {
    console.error('FATAL:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
