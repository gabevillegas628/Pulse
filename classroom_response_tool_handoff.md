# Classroom Response Tool — Project Handoff

## What This Is

A lightweight, self-hosted iClicker replacement built for Biochemistry 395 at Rutgers. No app installs, no grade sync nightmares, no vendor dependency. Students scan a QR code or type an access code, submit a text response, professor sees it live, exports CSV, done.

## Why We're Building This

iClicker works but requires:
- External app/subscription
- Unreliable Canvas grade sync
- Stopping class to set up polling
- Students to have the right app version

This tool should have zero friction. QR code lives in the corner of every slide permanently. Students scan at any point. No instruction needed mid-lecture.

## Core Use Case

**The Opener:** Every class starts with a clinical reasoning question (e.g. "Why is hyperbaric treatment appropriate for carbon monoxide poisoning?"). Students arrive, scan the QR code on the first slide, type a 1-3 sentence response, submit. Professor sees responses live, picks 2-3 to discuss, launches into lecture. Graded for engagement (did they write something real) not correctness.

**Mid-lecture questions (optional):** Same QR code stays on screen. If professor wants a quick pulse check, students just scan and respond without any setup.

## Spec

### Student-facing
- Mobile-first web app (phone browser, no install)
- QR code → URL with session ID embedded
- Fallback: 4-digit access code typed manually
- Fields: NetID + free text response
- Submit button, confirmation message, done
- Should work on any phone browser, minimal data usage

### Professor-facing
- Dashboard showing live incoming responses
- Responses shown as they come in (no refresh needed — websocket or polling)
- Flag short/empty responses automatically (< 10 words = suspicious)
- See response count vs enrolled count
- Export to CSV: NetID, response text, timestamp, word count
- Session management: create session, open, close, archive

### Access / Auth
- Professor login (just you for now, can be hardcoded credentials)
- Students need only the session URL or access code — no account, no login
- Sessions expire after class ends (manual close or time-based)

### Grade Integration
- No automatic Canvas sync — intentional
- CSV export → manual paste into Canvas gradebook
- Grading logic: 1 point for substantive response, 0 for empty/too short
- Optional: pipe responses to Claude API for auto-engagement scoring (see below)

## Optional Claude API Integration

Post-MVP feature. After session closes, send responses + question to Claude API for automated engagement scoring:

```javascript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: "You are grading student responses for engagement, not correctness. Return JSON only: {netid: string, score: 0|1, flag: boolean, note: string}. Score 1 if the student made a genuine biochemical argument. Score 0 if the response is empty, nonsensical, or clearly off-topic. Flag if the response appears to be AI-generated (suspiciously fluent, uses 'delve', generic structure).",
    messages: [{
      role: "user",
      content: `Question: ${question}\n\nResponses:\n${JSON.stringify(responses)}`
    }]
  })
});
```

## Tech Stack Suggestion

Keep it simple — you know this territory from DSAP:

- **Backend:** Node.js / Express
- **Database:** SQLite (small scale, no infra needed) or Postgres if you want Railway deploy
- **Frontend:** Vanilla JS or lightweight React — mobile-first, no build complexity
- **Realtime:** Socket.io for live response feed, or just poll every 3 seconds
- **QR generation:** `qrcode` npm package, generate on session creation
- **Hosting:** Railway (you already have the workflow) or just localhost for classroom use if you're on the same wifi

## What to Build First (MVP order)

1. Session creation → generates QR code + access code
2. Student submission form (mobile-friendly)
3. Live response dashboard (basic, just a list)
4. CSV export
5. Word count auto-flag
6. Professor auth
7. Session archive/history
8. Claude API engagement scoring (post-MVP)

## Placeholder for Summer Session (Before the Tool is Built)

Use a Google Form with a QR code pointing to it:
- Field 1: NetID
- Field 2: Paragraph response
- Responses sheet auto-populates, export CSV manually
- Same workflow, zero code, validates the concept before building

Generate QR code at: https://qr-code-generator.com or just use Google's built-in (Share → QR code on the form)

## What We Learned from iClicker That This Should Fix

- No mid-lecture setup friction — QR is always on screen
- Text responses only — MCQ invites guessing, text requires thought
- No app install — browser only
- No grade sync — manual CSV is fine, sync was the source of pain
- Customizable flagging — iClicker can't tell you a response was 3 words

## Timeline

- **Before summer session (2 weeks):** Google Form placeholder, validate workflow
- **During summer session:** Note what's missing, what format works
- **Post summer session:** Build MVP, target ready for Fall 2026

## Context

This came out of a longer conversation about AI detection in student essays, apostrophe forensics, and eventually a full course redesign discussion. The tool supports a new pedagogical structure:

- Every class opens with a clinical reasoning question (not recall)
- Opener is graded for engagement, worth a meaningful chunk of final grade (replacing publisher adaptive quizzes which were ~15%)
- Exam format shifting toward fewer MCQ, heavier FRQ weighting, more time per question
- Goal: students who reason like clinicians, not students who memorized Anki decks

The opener only works if the tool has zero friction. That's the whole design constraint.
