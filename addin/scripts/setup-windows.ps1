<#
.SYNOPSIS
  Sets up the Pulse add-in for sideloading in PowerPoint on Windows.

.DESCRIPTION
  Office on Windows will only load a sideloaded add-in from a *network path*
  (\\COMPUTER\ShareName), never a plain local path like C:\Something. That is the
  only reason a "shared folder" is involved - the folder never leaves your machine
  and nobody else needs access to it. You are sharing it with yourself.

  This script does four things:
    1. Creates the catalog folder.
    2. Shares it (needs an elevated shell - if not elevated it tells you the two
       clicks to do it by hand).
    3. Downloads the manifest from your Pulse server into it.
    4. Registers the folder as a Trusted Add-in Catalog for your user, which is
       the same thing as clicking through File > Options > Trust Center.

  Afterwards, restart PowerPoint and go to Home > Add-ins > Advanced > SHARED FOLDER.

.PARAMETER PulseUrl
  Base URL of your Pulse instance, e.g. https://pulse.recommate.net

.PARAMETER FolderPath
  Local folder to use as the catalog. Default C:\PulseAddinCatalog

.PARAMETER ShareName
  Windows share name. Default PulseAddinCatalog

.EXAMPLE
  .\setup-windows.ps1 -PulseUrl https://pulse.recommate.net
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PulseUrl,

  [string]$FolderPath = 'C:\PulseAddinCatalog',

  [string]$ShareName = 'PulseAddinCatalog'
)

$ErrorActionPreference = 'Stop'

function Write-Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Write-Ok($text)       { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Warn2($text)    { Write-Host "    !!  $text" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$uncPath = "\\$env:COMPUTERNAME\$ShareName"
$PulseUrl = $PulseUrl.TrimEnd('/')

Write-Host "Pulse add-in setup" -ForegroundColor White
Write-Host "  computer   : $env:COMPUTERNAME"
Write-Host "  folder     : $FolderPath"
Write-Host "  network path: $uncPath"
Write-Host "  elevated   : $isAdmin"

# -- 1. Folder ----------------------------------------------------------------
Write-Step 1 "Create the catalog folder"
if (Test-Path $FolderPath) {
  Write-Ok "already exists: $FolderPath"
} else {
  New-Item -ItemType Directory -Path $FolderPath | Out-Null
  Write-Ok "created $FolderPath"
}

# -- 2. Share -----------------------------------------------------------------
Write-Step 2 "Share the folder (so Office has a \\ path to read)"
$existing = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Ok "share '$ShareName' already exists -> $($existing.Path)"
} elseif ($isAdmin) {
  New-SmbShare -Name $ShareName -Path $FolderPath -FullAccess $env:USERNAME | Out-Null
  Write-Ok "shared as $uncPath"
} else {
  Write-Warn2 "Not running as administrator, so the share can't be created here."
  Write-Host ""
  Write-Host "    Do this by hand (about 15 seconds):" -ForegroundColor White
  Write-Host "      a. Open File Explorer and find $FolderPath"
  Write-Host "      b. Right-click it -> Properties -> the 'Sharing' tab"
  Write-Host "      c. Click the 'Share...' button"
  Write-Host "      d. Make sure your own username is listed with Read/Write, then click 'Share'"
  Write-Host "      e. Click 'Done', then 'Close'"
  Write-Host ""
  Write-Host "    Then re-run this script. Or re-run it in an elevated PowerShell" -ForegroundColor White
  Write-Host "    (right-click PowerShell -> Run as administrator) to skip the clicking."
  Write-Host ""
  Write-Host "    Stopping here - the remaining steps need the share to exist." -ForegroundColor Yellow
  exit 1
}

# -- 3. Manifest --------------------------------------------------------------
Write-Step 3 "Download the manifest from $PulseUrl"
$manifestUrl = "$PulseUrl/addin/manifest.xml"
$manifestPath = Join-Path $FolderPath 'pulse-manifest.xml'
try {
  Invoke-WebRequest -Uri $manifestUrl -OutFile $manifestPath -UseBasicParsing
} catch {
  Write-Warn2 "Could not download $manifestUrl"
  Write-Warn2 $_.Exception.Message
  Write-Warn2 "Is the add-in deployed? Check that $manifestUrl opens in a browser."
  exit 1
}

# Sanity-check it, so a 404 HTML page doesn't get mistaken for a manifest.
try {
  [xml]$m = Get-Content $manifestPath -Raw
  $source = $m.OfficeApp.DefaultSettings.SourceLocation.DefaultValue
  Write-Ok "manifest saved to $manifestPath"
  Write-Host "        task pane: $source"
  if ($source -notlike 'https://*') {
    Write-Warn2 "Task pane URL is not HTTPS. Office refuses add-in content over plain HTTP."
    Write-Warn2 "Set BASE_URL on the Pulse server to its https:// origin and re-run."
  }
} catch {
  Write-Warn2 "Downloaded file is not valid XML - the server probably returned an error page."
  exit 1
}

# -- 4. Trust the catalog -----------------------------------------------------
Write-Step 4 "Register the folder as a Trusted Add-in Catalog"
$catalogRoot = 'HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs'
if (-not (Test-Path $catalogRoot)) { New-Item -Path $catalogRoot -Force | Out-Null }

# A catalog must be a *folder* - a network share, or a SharePoint catalog. Pointing one
# at an https:// manifest file is a natural mistake that silently never works, so flag it.
Get-ChildItem $catalogRoot -ErrorAction SilentlyContinue | ForEach-Object {
  $u = (Get-ItemProperty $_.PSPath -Name Url -ErrorAction SilentlyContinue).Url
  if ($u -and $u -notlike '\\*' -and $u -like '*.xml') {
    Write-Warn2 "Existing catalog entry points at a manifest file, not a folder:"
    Write-Warn2 "  $u"
    Write-Warn2 "  That entry cannot work. Remove it with:"
    Write-Warn2 "  Remove-Item '$($_.PSPath)' -Recurse"
  }
}

# Reuse the entry if this path is already trusted, so re-running doesn't pile up
# duplicate catalogs in the Trust Center list.
$existingKey = Get-ChildItem $catalogRoot -ErrorAction SilentlyContinue | Where-Object {
  (Get-ItemProperty $_.PSPath -Name Url -ErrorAction SilentlyContinue).Url -eq $uncPath
}

if ($existingKey) {
  Write-Ok "already trusted ($($existingKey.PSChildName))"
} else {
  $guid = "{$([guid]::NewGuid().ToString())}"
  $key = Join-Path $catalogRoot $guid
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name 'Id'    -Value $guid   -PropertyType String | Out-Null
  New-ItemProperty -Path $key -Name 'Url'   -Value $uncPath -PropertyType String | Out-Null
  # Flags=1 is the "Show in Menu" checkbox in the Trust Center UI.
  New-ItemProperty -Path $key -Name 'Flags' -Value 1       -PropertyType DWord  | Out-Null
  Write-Ok "trusted $uncPath"
}

# -- Done ---------------------------------------------------------------------
Write-Host "`nDone." -ForegroundColor Green
Write-Host @"

Next, in PowerPoint:
  1. Close PowerPoint completely if it is open, then reopen it.
     (Trust Center changes are only read at startup.)
  2. Home tab -> Add-ins -> Advanced
  3. Click SHARED FOLDER at the top of the dialog
  4. Select "Pulse" and click Add

If "Pulse" does not appear, the usual causes are:
  - PowerPoint was not fully restarted
  - the manifest is not in $FolderPath
  - the share does not resolve: paste $uncPath into File Explorer and check it opens

To remove the add-in later, clear the Office cache:
  https://learn.microsoft.com/office/dev/add-ins/testing/clear-cache
"@
