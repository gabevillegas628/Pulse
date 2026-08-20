# Pulse PowerPoint add-in

Insert question QR codes onto slides and keep them true across semesters.

## What it does

A "Pulse Question" is an ordinary picture shape carrying tags that record which question it
points at. The tags live inside the `.pptx`, so the binding survives save, close, copy, and
send — and the add-in can check the whole deck in one pass.

- **Insert** — pick class → session → question, drop the QR on the current slide, tagged.
- **Deck status** — checks every tagged shape against the API on open. Tells you what's stale
  instead of letting you find out in the lecture hall.
- **Fix all** — reconciles. Tries to move the code the deck already has onto the question
  (nothing in the file changes); only replaces the image when that code is genuinely taken.
- **New semester** — after duplicating a class, re-binds the whole deck in one step. Matched
  slides keep their existing QR image.

## Why the images stay static

The add-in writes a plain PNG into the slide rather than rendering live content. A content
add-in *does* render during a slide show, but it needs network and a successful add-in load at
lecture time — and a failure puts a blank box on the projector. A static image works offline,
prints, and exports to PDF.

## Requirements

- PowerPoint desktop, Windows or Mac
- PowerPoint API 1.4 or later (tags need 1.3; repositioning refreshed QR codes needs 1.4).
  The add-in checks on load and says so plainly if unavailable.
- The Pulse server reachable over **HTTPS** — Office refuses add-in content over plain HTTP.

## Sideloading

Get the manifest from your own Pulse instance, so its URLs already point at the right place:

```
https://<your-pulse-host>/addin/manifest.xml
```

Save it as `pulse-manifest.xml`.

**Windows** — put the manifest in a folder, share that folder, then in PowerPoint:
File → Options → Trust Center → Trust Center Settings → Trusted Add-in Catalogs. Add the
share's **path** (`\\MACHINE\share`), tick *Show in Menu*, restart PowerPoint, then
Insert → My Add-ins → Shared Folder → Pulse.

**Mac** — copy the manifest into:

```
~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef
```

Create the folder if it doesn't exist, restart PowerPoint, then Insert → My Add-ins → Pulse.

## Development

The add-in is served by the Express app at `/addin`, same origin as the API, so there is no
CORS setup. Build it and the server serves it:

```
npm run build --workspace=addin
```

`BASE_URL` on the backend drives the manifest URLs. It must be an HTTPS origin for a manifest
you intend to sideload; a `localhost` value produces a manifest that only works with a
[dev-cert](https://learn.microsoft.com/office/dev/add-ins/testing/test-debug-office-add-ins)
setup.

For fast iteration on the UI alone, `npm run dev --workspace=addin` serves the pane on :5174
and proxies `/api` to :3001 — useful in a browser, but Office itself must load the built copy.

## Notes

- The professor token is kept in the task pane's `localStorage` and **never** written into the
  document. Decks get shared with TAs and students; tags hold only class/session/question ids
  and the access code.
- Tag keys are uppercase — PowerPoint stores them that way and some tag APIs require it.
- Images are inserted with the Common API `setSelectedDataAsync`, not
  `ShapeCollection.addPicture`, which is preview-only and marked unfit for production. The
  inserted shape is identified by diffing slide shape ids before and after.
