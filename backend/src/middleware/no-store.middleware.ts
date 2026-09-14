import type { Express } from 'express'

/**
 * Keep every API response out of the browser's HTTP cache.
 *
 * The 14 Sep sign-in loop. Express tags every `res.json` with an ETag, and nothing said not
 * to store the response, so the browser kept them — headers included. A renewal is a header
 * (`X-Pulse-Token`), so a stored response carried a renewed token with it. Days later a
 * poll whose body had not changed was answered 304, and the browser handed the client the
 * stored 200 *with the stored header*: an 11 Sep token, dead since the 12th, written over a
 * sign-in made six seconds earlier. The fresher the sign-in the likelier the replay, because
 * a token under an hour old gets no renewal header of its own to overwrite the stored one.
 * In PowerPoint it never let go — sign in, reload, poll, replay, 401, sign in.
 *
 * Both halves are needed. `no-store` stops new responses being kept. Turning the ETag off
 * is what cleans up caches that are *already* poisoned on machines nobody will clear by
 * hand: their stale entry still sends If-None-Match, and with no ETag to match the server
 * cannot answer 304, so it sends a full 200 and the entry is replaced.
 *
 * `etag` is an app setting that governs `res.send` only. express.static and sendFile carry
 * their own, so the frontend's assets keep their validators.
 */
export function applyApiCachePolicy(app: Express): void {
  app.set('etag', false)
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
}
