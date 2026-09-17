/**
 * Which open run, if any, a student may answer.
 *
 * This lived in three places — the code lookup, the question fetch and the submit — as three
 * copies of one `runs.find(...)`. Three copies of an access gate is how one grows a hole:
 * the rule only holds if every door agrees, and nothing made them agree except care.
 *
 * The rule refuses exactly one thing: a student enrolled in a *different* section. Everyone
 * else is admitted, and that distinction is the whole point. An enrollment row that does not
 * exist and one whose section is null both used to read as "section null", which collapsed a
 * student with no stated section together with a student who has stated a different one —
 * and refused both. So a newcomer scanning the code on the wall of the room they are sitting
 * in was turned away, told "this session is not open" about a session that plainly was.
 *
 * Nothing about such a student contradicts the run, so there is nothing to protect. The
 * caller stamps them with the run's section on the way through, which is what makes scanning
 * in a sectioned class as frictionless as it already was in a class without them, and what
 * lets rosters left unassigned by an earlier all-sections run heal themselves on first scan.
 *
 * Proximity is treated as evidence of belonging: being in the room when the code goes up is
 * what says which section you are in. A student who genuinely belongs elsewhere is still
 * refused, because they carry a section that says so.
 */

/** Just enough of a run to decide. Generic so callers keep whatever else they selected. */
export interface RunSectionRef {
  sectionId: string | null
}

/** Just enough of an enrollment to decide. `null` means no row at all — a new student. */
export interface EnrollmentSectionRef {
  sectionId: string | null
}

export function openRunFor<R extends RunSectionRef>(
  runs: R[],
  enrollment: EnrollmentSectionRef | null
): R | undefined {
  return runs.find((r) =>
    // Open to the whole class. Only reachable for a class with no sections — a class that
    // has them is refused a sectionless run when it opens one.
    r.sectionId === null
    // Never seen this class before: nothing on record to contradict the room they are in.
    || enrollment === null
    // On the roster, no section stated. Same reasoning, plus this is what heals a roster
    // left unassigned by an all-sections run opened before that was disallowed.
    || enrollment.sectionId === null
    // Their own section.
    || enrollment.sectionId === r.sectionId
  )
}
