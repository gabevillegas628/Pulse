/**
 * The scrub that takes identifying details out of answer text before a model sees it
 * (src/ai/scrub.ts). Pure: no database, no model.
 *
 *   npx tsx scripts/smoke-scrub.ts
 *
 * Half of these check that it removes what it should; the other half that it leaves the
 * chemistry alone, since an answer the scrub mangled would be graded on the wrong text.
 */
import { makeScrubber } from '../src/ai/scrub.js'

let passed = 0
let failed = 0
function eq(name: string, got: string, want: string) {
  if (got === want) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}\n      got:  ${got}\n      want: ${want}`) }
}

const scrub = makeScrubber([
  { netId: 'jd1234', email: 'jane.doe@rutgers.edu' },
  { netId: 'mk88', email: 'mk88@scarletmail.rutgers.edu' },
  { netId: 'hk55', email: 'hans.krebs@rutgers.edu' },
  { netId: 'admin', email: 'admin@example.com' },
])

const t = (name: string, input: string, want: string) => eq(name, scrub(input), want)

console.log('removed')
t('a NetID', 'jd1234 thinks the enzyme is allosteric', '[netid] thinks the enzyme is allosteric')
t('a NetID in other capitals', 'as JD1234 said', 'as [netid] said')
t("a classmate's NetID", 'same as mk88', 'same as [netid]')
t('an email, NetID and all', 'email me at mk88@scarletmail.rutgers.edu', 'email me at [email]')
t('any email address', 'or jdoe99@gmail.com', 'or [email]')
t('a full name, from the email', 'Jane Doe here: hexokinase', '[name] here: hexokinase')
t('surname first', 'Doe, Jane — answer below', '[name] — answer below')
t('dotted', 'jane.doe wrote this', '[name] wrote this')
t('a nine-digit ID', 'RUID 123456789', 'RUID [id number]')
t('a phone number', 'call 732-555-0123', 'call [phone]')
t('a phone number in brackets', 'call (732) 555-0123', 'call [phone]')

console.log('left alone')
const chem = 'CO2, H2O, NAD+, FADH2, ATP, C6H12O6, Km = 2.5 mM, pH 7.4, k1 > k2, 3-phosphoglycerate'
eq('formulas and constants', scrub(chem), chem)
t('a first name alone', 'Jane', 'Jane')
t('a surname alone, even when it is chemistry', 'the Krebs cycle makes NADH', 'the Krebs cycle makes NADH')
t('a NetID that looks like a word is not matched', 'the admin step', 'the admin step')
t('a NetID inside a longer token', 'xjd1234y', 'xjd1234y')
t('ten digits are not an ID', '1234567890', '1234567890')
t('a decimal is not an ID', '0.123456789 M', '0.123456789 M')
t('Avogadro is not an ID', '6.022e23', '6.022e23')
t('blank stays blank', '', '')

eq('an empty roster still removes emails and IDs', makeScrubber([])('jd1234 / x@y.edu / 123456789'), 'jd1234 / [email] / [id number]')

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
