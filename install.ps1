<#
.SYNOPSIS
    Install (or remove) the dsh-cost-meter plugin in a DSH web profile.

.DESCRIPTION
    Copies the package into the profile's own node_modules — the first stop of
    the loader's bare-specifier resolution, which is anchored at the profile
    directory — and adds one row to the profile's cordis.patch.yml.

    Built for DSH 0.2.x. Restart the application once after installing: the row
    is read from the profile patch document at boot, and only some profiles opt
    into live config reload. The browser then needs one page refresh to fetch the
    new client bundle.

    Every step is idempotent: re-running refreshes the copied files and leaves an
    already-patched cordis.patch.yml alone.

.PARAMETER Uninstall
    Remove the row and the installed package directory, leaving a backup of the
    patch file behind.

.PARAMETER DshHome
    Harness home; defaults to $env:DSH_HOME, then $HOME\.dsh.

.PARAMETER Profile
    Profile name; defaults to `web`.

.EXAMPLE
    pwsh -File install.ps1
    pwsh -File install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$DshHome,
    [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageName = 'dsh-cost-meter'
$rowId = 'cost-meter'
$marker = "# >>> $packageName"
$endMarker = "# <<< $packageName"

if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
}
if (-not (Test-Path $DshHome)) { throw "harness home not found: $DshHome" }

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$profileManifest = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$modulesDir = Join-Path $profileDir 'node_modules'
$targetDir = Join-Path $modulesDir $packageName

if (-not (Test-Path $profileManifest)) {
    throw "profile manifest not found: $profileManifest (is '$Profile' the right profile name?)"
}
if (-not (Test-Path $patchPath)) {
    throw "profile patch file not found: $patchPath"
}

function Read-PatchText {
    Get-Content -LiteralPath $patchPath -Raw
}

function Write-PatchText([string]$Text) {
    Set-Content -LiteralPath $patchPath -Value $Text -Encoding utf8 -NoNewline
}

function Backup-PatchFile {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$patchPath.bak-$stamp"
    Copy-Item -LiteralPath $patchPath -Destination $backup -Force
    Write-Host "backup: $backup"
}

# ── uninstall ───────────────────────────────────────────────────────────────

# Whether the patch document still carries any entry list at all.
function Test-PatchHasEntries([string]$Text) {
    foreach ($line in $Text -split "`r?`n") {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0) { continue }
        if ($trimmed.StartsWith('#')) { continue }
        return $true
    }
    return $false
}

if ($Uninstall) {
    $text = Read-PatchText
    if ($text.Contains($marker)) {
        Backup-PatchFile
        $start = $text.IndexOf($marker)
        $end = $text.IndexOf($endMarker)
        if ($end -lt 0) { throw "found '$marker' without its closing '$endMarker'; edit $patchPath by hand" }
        $end += $endMarker.Length
        # Swallow the trailing newline so the removal leaves no blank residue.
        while ($end -lt $text.Length -and ($text[$end] -eq "`n" -or $text[$end] -eq "`r")) { $end++ }
        $text = $text.Remove($start, $end - $start)
        # An empty patch file parses as `null`, not as an empty entry list, so a
        # removal that empties the document must restore the `[]` sentinel.
        if (-not (Test-PatchHasEntries $text)) {
            $text = $text.TrimEnd() + "`n[]`n"
            Write-Host "restored the empty entry list '[]' in $patchPath"
        }
        Write-PatchText $text
        Write-Host "removed the $rowId row from $patchPath"
    }
    else {
        Write-Host "no $packageName row in $patchPath; nothing to remove there"
    }
    if (Test-Path $targetDir) {
        Remove-Item -LiteralPath $targetDir -Recurse -Force
        Write-Host "removed $targetDir"
    }
    Write-Host "`nRefresh the page. Uninstall complete."
    return
}

# ── install ─────────────────────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null

Write-Host "installing $packageName"
Write-Host "  from: $here"
Write-Host "  to  : $targetDir"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
foreach ($entry in @('package.json', 'lib', 'test', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'install.ps1')) {
    $source = Join-Path $here $entry
    if (-not (Test-Path $source)) { continue }
    $destination = Join-Path $targetDir $entry
    if (Test-Path $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

$row = @"
$marker
# Composer spend pill + its settings page. Prices are fetched from DeepSeek's
# two published price pages (CNY by default, USD switchable), billed
# by each request's start time and priced from daily snapshots; edit the sources or fall back to
# manual prices in Settings -> 花费金额（估算）.
# insert is load-bearing: a bare "- id:" block PATCHES an existing row of that
# id and is skipped with "entry not found" when none exists.
- insert:
    - id: $rowId
      name: $packageName
$endMarker
"@

$text = Read-PatchText
if ($text.Contains($marker)) {
    Write-Host "patch: already present in $patchPath (left unchanged)"
}
else {
    Backup-PatchFile
    if ($text -match '(?m)^\s*\[\s*\]\s*$') {
        $text = [regex]::Replace($text, '(?m)^\s*\[\s*\]\s*$', { param($m) $row })
    }
    else {
        $text = $text.TrimEnd() + "`n`n" + $row + "`n"
    }
    Write-PatchText $text
    Write-Host "patch: added the $rowId row to $patchPath"
}

Write-Host @"

Next steps
  1. Restart DeepSeek Harness so the loader composes the new row. Profiles that
     opt into live config reload pick it up on their own; this one does not.
  2. Refresh the Web page so it fetches the new client bundle.
  3. The spend pill appears at the END of the composer dock line, to the right of
     the shipped activity and token-usage pills; it opens a cost detail panel.
  4. Check Settings -> 花费金额（估算）. The host fetches DeepSeek's published
     price table and records a daily snapshot; each request is billed at the
     peak/off-peak price in force when it started. The page shows the catalog's
     age, the snapshot range, and a refresh button.

Verify (the web server 404s unauthenticated /plugins probes, so check the host side):
  node test\verify-install.mjs

Uninstall:
  pwsh -File "$($MyInvocation.MyCommand.Path)" -Uninstall
"@
