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

### Server requirements

The `/addin` routes are served with their own Content-Security-Policy, set in
`backend/src/app.ts`. This is not optional decoration:

- `script-src` must include `https://appsforoffice.microsoft.com`. Office add-ins have to
  load `office.js` from Microsoft's CDN — self-hosting it is unsupported, since the
  library is version-matched to the Office host. Under the app-wide `script-src 'self'`
  the script is blocked, `Office.onReady` never fires, no event handlers are attached,
  and the task pane renders as dead static HTML: **you see the UI, and every button does
  nothing.** There is no visible error.
- `frame-ancestors` must allow the Office hosts, and `X-Frame-Options` must not be sent,
  because Office frames these pages (the task pane host and the dialog API).

If you ever see the pane render but not respond, check the response headers on
`/addin/taskpane.html` before suspecting anything else.

## Sideloading

Everything below assumes the add-in is deployed and
`https://<your-pulse-host>/addin/manifest.xml` opens in a browser. Check that first —
if it 404s, nothing else will work.

**Fair warning: this process is genuinely fiddly.** It is not you. Office's sideloading
story for desktop is a network share, a Trust Center entry, and a full app restart, with
no useful error message when any of the three is wrong. Traps worth knowing up front:

- **Creating the share needs administrator rights.** The script says so and falls back to
  manual instructions, but plan on either an elevated PowerShell or five clicks in
  Explorer.
- **The Trust Center wants a folder, not a file.** Pasting
  `https://…/addin/manifest.xml` into *Catalog Url* looks right and silently never works.
  If you did that once, remove the entry — a dead catalog stays in the list forever and
  makes later diagnosis confusing:
  ```powershell
  Get-ChildItem 'HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs' |
    ForEach-Object { $_.PSPath, (Get-ItemProperty $_.PSPath).Url }
  # then Remove-Item '<the PSPath whose Url is not a \\ path>' -Recurse
  ```
- **PowerPoint must be fully quit and reopened**, not just the window closed. Trust Center
  changes are read once at startup.
- **The add-in appearing but doing nothing** is usually a Content-Security-Policy problem
  on the server, not a sideloading problem. See *Server requirements* below.

### Windows

**Why a "shared folder" is involved at all:** Office on Windows will only load a
sideloaded add-in from a *network path* like `\\COMPUTER\FolderName`. It will not accept
a normal local path like `C:\Something`. So you take an ordinary folder on your own
machine and share it **with yourself**. Nothing is exposed to anyone else, nothing leaves
your computer, and no other machine needs to reach it. It is a quirk of how Office looks
up catalogs, not a real networking step.

The catalog is a **folder**, not a file. A common mistake is to paste the
`https://.../manifest.xml` URL into the Trust Center — that silently never works.

#### The scripted way

From the repo:

```powershell
cd addin\scripts
.\setup-windows.ps1 -PulseUrl https://pulse.recommate.net
```

It creates the folder, shares it, downloads the manifest into it, and registers it as a
trusted catalog. Run it in an **elevated** PowerShell (right-click PowerShell → *Run as
administrator*) and it does everything; run it unelevated and it will do the rest but ask
you to make the share by hand, because creating a Windows share needs admin.

Then restart PowerPoint and skip to *Insert the add-in* below.

#### By hand

1. **Make a folder.** Anywhere. `C:\PulseAddinCatalog` is fine.

2. **Put the manifest in it.** Open `https://<your-pulse-host>/addin/manifest.xml`,
   save it into that folder. The filename doesn't matter; the extension must stay `.xml`.

3. **Share the folder with yourself.**
   - In File Explorer, right-click the folder → **Properties**
   - Go to the **Sharing** tab
   - Click the **Share...** button
   - Your own username should be listed with **Read/Write** permission. If it isn't, pick
     it from the dropdown and click *Add*.
   - Click **Share**. Windows may ask for admin confirmation.
   - The confirmation screen shows a **network path** under the folder name, like
     `\\GABE_ZENDUO\PulseAddinCatalog`. **Write it down** — that is what Office wants.
   - Click **Done**, then **Close**.

   Lost the path? It's `\\` + your computer name + `\` + the share name. Your computer
   name is in Settings → System → About, or run `hostname` in a terminal.

4. **Tell Office to trust that folder.**
   - Open PowerPoint (any presentation)
   - **File** → **Options** → **Trust Center** → **Trust Center Settings...**
   - Choose **Trusted Add-in Catalogs** in the left list
   - Paste the network path from step 3 into **Catalog Url** — the `\\COMPUTER\Folder`
     path, *not* the https link to the manifest
   - Click **Add catalog**
   - Tick the **Show in Menu** checkbox next to the row that just appeared
   - **OK**, then **OK** again

5. **Fully close and reopen PowerPoint.** Trust Center changes are only read at startup.

#### Insert the add-in

- **Home** tab → **Add-ins** → **Advanced**
- Click **SHARED FOLDER** at the top of the dialog
- Select **Pulse** → **Add**

(On older builds this dialog is under *Insert* → *My Add-ins* instead.)

#### When it doesn't appear

- PowerPoint wasn't fully restarted — quit it entirely, not just the window
- The manifest isn't in the shared folder, or got saved as `.txt`
- The share doesn't resolve — paste `\\COMPUTER\FolderName` into File Explorer's address
  bar; if it doesn't open, the share isn't set up
- The catalog was added as an `https://.../manifest.xml` URL rather than a folder path
- The task pane URL in the manifest isn't HTTPS — Office refuses add-in content over plain
  HTTP. Check `BASE_URL` on the Pulse server.

### Mac

Simpler — no sharing, just a folder Office already watches.

1. In Finder, press **⌘⇧G** and go to:

   ```
   ~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef
   ```

   Create the `wef` folder if it isn't there.

2. Save `https://<your-pulse-host>/addin/manifest.xml` into it.

3. Restart PowerPoint, then **Insert** → **My Add-ins** → **Pulse**.

### Removing it

Clear the Office cache — see
[Clear the Office cache](https://learn.microsoft.com/office/dev/add-ins/testing/clear-cache).

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
