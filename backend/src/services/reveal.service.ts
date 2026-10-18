/**
 * When a fill-in-the-blank question's answers may go up on the projector.
 *
 * For these the room's answers *are* the answers, so a distribution on the wall while
 * people are still typing is a copy channel. Hiding them until the end would cost the
 * thing the projector is for, so they go up once most of the room is in. That doesn't
 * make the question timed: nothing closes, late answers are still taken, and the reveal
 * only decides what the slide shows.
 *
 * "Most of the room" is measured against the students who have answered anything in this
 * opening, which is the room in front of you. The roster would be the wrong base: on a
 * day with 60% attendance a share of enrolment would never be reached.
 *
 * That base has one blind spot. On the first question of an opening, the only people known
 * to be in the room are the ones who answered it, so the share is met by the first answer.
 * The quiet spell covers that, and it is a fair signal on its own: answers arrive in a
 * burst, and a pause after the burst is the room being done.
 *
 * Once revealed, a question stays revealed for the rest of the opening, so a student
 * arriving late cannot make the results vanish from under a discussion. The latch is in
 * memory like the close clock; after a restart it is simply decided again.
 */

/** Share of the room that must have answered. */
export const REVEAL_SHARE = 0.75
/** How long answers must have stopped arriving, in ms. */
export const REVEAL_QUIET_MS = 10_000

const revealed = new Set<string>()

export function blanksRevealed(
  runId: string,
  questionId: string,
  answered: number,
  roomSize: number,
  lastAnswerAt: number | null,
  now: number,
): boolean {
  const key = `${runId}:${questionId}`
  if (revealed.has(key)) return true
  if (answered === 0 || lastAnswerAt === null) return false
  const enough = answered >= Math.ceil(REVEAL_SHARE * Math.max(roomSize, answered))
  const quiet = now - lastAnswerAt >= REVEAL_QUIET_MS
  if (enough && quiet) {
    revealed.add(key)
    return true
  }
  return false
}
