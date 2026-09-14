# Security Findings

Audit date: 2026-06-02  
Last updated: 2026-06-03 (items #1, #4, #6, #7, #8 fixed; #9 closed as accepted risk)  
Scope: Full app with focus on Ketcher / Indigo integration

---

## Critical

### 1. Unprotected Indigo REST API Proxy
**File:** `backend/src/app.ts`  
**Status:** ✅ Fixed on 2026-06-03

`requireAnyAuth` middleware added to `auth.middleware.ts` — verifies JWT signature only (no DB
lookup, since Ketcher calls this on every render). Wired before the proxy in `app.ts`:

```ts
app.use('/api/indigo', requireAnyAuth)
```

---

### 2. CSP Allows `unsafe-eval`
**File:** `backend/src/app.ts:27`  
**Status:** Partially fixed — `unsafe-inline` removed from `scriptSrc` on 2026-06-03. `unsafe-eval` blocked on Ketcher upstream ([epam/ketcher#6603](https://github.com/epam/ketcher/issues/6603)).

`unsafe-inline` has been removed from `scriptSrc`. `unsafe-eval` remains and cannot be removed:
it is a known Ketcher bug. AJV (bundled inside Ketcher) uses `new Function()` to compile
validators at runtime, which violates strict CSP. This is tracked in the Ketcher repo as issue
#6603 (opened March 2025, assigned to milestone 3.16.0-rc.1) with AJV standalone code generation
as the planned fix path. No workaround exists in the current Ketcher 3.x releases.

```ts
// Current state — unsafe-inline removed, unsafe-eval required by Ketcher bug
scriptSrc: ["'self'", "'unsafe-eval'"],
styleSrc:  ["'self'", "'unsafe-inline'"],  // unsafe-inline on styles is low-impact
```

`unsafe-eval` risk is real but bounded. Its practical impact depends on whether an XSS injection
point exists — the textbook sanitization fix (finding #3) closes the main one.

**Action:** Watch for Ketcher 3.16.0 release. Once available, upgrade and remove `unsafe-eval`
from `scriptSrc`.

---

### 3. Textbook HTML Rendered Without Sanitization
**Status:** ✅ Fixed on 2026-06-03

Server-side `rehype-sanitize` added to the markdown pipeline in `backend/src/routes/textbook.routes.ts`.
Approach follows the official rehype-sanitize + remark-math recommendation: sanitize *before*
the math plugin, not after. At sanitization time, math expressions are still simple
`<code class="math-inline/math-display">` nodes — the sanitizer just needs to allow those two
class names. After sanitization, `rehypeMathjax` converts them to SVG (trusted library output,
never user input).

Pipeline order (fixed):
```
remarkRehype → rehypeRaw → rehypeSanitize → rehypeMathjax → rehypeSlug → rehypeStringify
```

Schema extension (minimal):
```ts
code: [['className', /^language-./, 'math-inline', 'math-display']]
```

`allowDangerousHtml: true` and `rehypeRaw` are intentionally kept — they allow professors to use
safe HTML in markdown (tables, details/summary, etc.). `rehypeRaw` parses raw HTML string nodes
into HAST *before* sanitization, which is what makes the sanitizer able to strip dangerous ones.
Without it, raw HTML nodes bypass the sanitizer as opaque strings.

---

## High

### 4. No SMILES / Molecule Validation on Submitted Responses
**File:** `backend/src/routes/responses.routes.ts`  
**Status:** ✅ Partially fixed on 2026-06-03

`responseText` capped at 10 000 characters via `z.string().max(10_000)`. Full SMILES format
validation against the Indigo `/check` endpoint remains an optional improvement but is not
implemented.

---

## Medium

### 5. ~~Inconsistent DOMPurify Usage~~
**Status:** ✅ Resolved — superseded by finding #3

The original finding was that `TextbookPage` lacked DOMPurify while `RichTextRenderer` used it.
This is now moot: textbook content is sanitized server-side before it reaches the client.
Client-side DOMPurify on the textbook was attempted but broke MathJax (DOMPurify strips SVG
`<use href>` references at the string level). Server-side sanitization is the correct layer.

---

### 6. Indigo Service URL Not Validated
**File:** `backend/src/app.ts`  
**Status:** ✅ Fixed on 2026-06-03

`INDIGO_SERVICE_URL` validated at startup using `new URL()` with a protocol allowlist. Server
throws on startup if the value is not a valid `http`/`https` URL.

---

### 7. JWT Secret Has Insecure Default
**File:** `backend/src/config/index.ts`  
**Status:** ✅ Fixed on 2026-06-03

Config now throws at startup if `JWT_SECRET` is unset and `NODE_ENV=production`. The dev
fallback is retained for local development only.

---

### 8. No Rate Limiting on `/api/indigo`
**File:** `backend/src/app.ts`  
**Status:** ✅ Fixed on 2026-06-03

`express-rate-limit` applied at 120 req/min per user. Wired alongside `requireAnyAuth` on the
`/api/indigo` path.

---

### 9. File Upload MIME Type Validation is Bypassable
**File:** `backend/src/routes/uploads.routes.ts`  
**Status:** ✅ Closed — accepted risk

Upload is professor-only (`requireProfessor`), files get randomized names, and they're served
by Express static which doesn't execute anything. No viable attack chain exists in this
deployment context.

---

## Open items summary

| # | Finding | Severity | Effort |
|---|---------|----------|--------|
| 2 | `unsafe-eval` in CSP (Ketcher/AJV) | Critical | Blocked on Ketcher 3.16.0 |

---

## Action items

### #2 — `unsafe-eval` in CSP
**File:** `backend/src/app.ts`

No action available now. Watch the [epam/ketcher#6603](https://github.com/epam/ketcher/issues/6603)
milestone (3.16.0-rc.1). When released:

```
npm install ketcher-react@latest ketcher-core@latest
```

Then remove `'unsafe-eval'` from `scriptSrc` and verify the editor still loads.

---

