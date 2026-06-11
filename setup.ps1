#Requires -Version 5.1
param(
    [Parameter(Position = 0)]
    [string]$Command = "help"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Self = if ($MyInvocation.MyCommand.Name -match 'setup') { '.\setup.ps1' } else { 'polyt' }
$ModelsDir = Join-Path $ScriptDir 'models'
$RegistryUrl = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records?_limit=500'
$CDN = 'https://firefox-settings-attachments.cdn.mozilla.net'

# ── Language definitions ──

$NonEnLangs = @('ar','zh','da','nl','fr','de','el','he','hi','it','ja','ko','no','pl','pt','ro','ru','sr','es','sv','th','uk','vi')

$LangNames = @{
    ar='Arabic'; zh='Chinese'; da='Danish'; nl='Dutch'; en='English'; fr='French'
    de='German'; el='Greek'; he='Hebrew'; hi='Hindi'; it='Italian'; ja='Japanese'
    ko='Korean'; no='Norwegian'; pl='Polish'; pt='Portuguese'; ro='Romanian'; ru='Russian'
    sr='Serbian'; es='Spanish'; sv='Swedish'; th='Thai'; uk='Ukrainian'; vi='Vietnamese'
}

$BergCodes = @{
    ar='ar'; zh='zh-Hans'; da='da'; nl='nl'; en='en'; fr='fr'
    de='de'; el='el'; he='he'; hi='hi'; it='it'; ja='ja'
    ko='ko'; no='nb'; pl='pl'; pt='pt'; ro='ro'; ru='ru'
    sr='sr'; es='es'; sv='sv'; th='th'; uk='uk'; vi='vi'
}

function Get-LangName($lang)  { if ($LangNames.ContainsKey($lang)) { $LangNames[$lang] } else { $lang } }
function Get-BergCode($lang)  { if ($BergCodes.ContainsKey($lang)) { $BergCodes[$lang] } else { $lang } }

# ── Helpers ──

$ESC = [char]0x1B

function Write-Color($text, $code) { Write-Host "${ESC}[${code}m${text}${ESC}[0m" -NoNewline }
function Write-Bold($text)   { Write-Color $text '1' }
function Write-Green($text)  { Write-Color $text '32' }
function Write-Yellow($text) { Write-Color $text '33' }
function Write-Red($text)    { Write-Color $text '31' }
function Write-Dim($text)    { Write-Color $text '2' }

function Test-PairComplete($dir) {
    if (-not (Test-Path $dir)) { return $false }
    $hasBin = @(Get-ChildItem -Path $dir -Filter '*.bin' -ErrorAction SilentlyContinue).Count -gt 0
    $hasSpm = @(Get-ChildItem -Path $dir -Filter '*.spm' -ErrorAction SilentlyContinue).Count -gt 0
    return ($hasBin -and $hasSpm)
}

function Get-LangStatus($lang) {
    $toDir   = Join-Path $ModelsDir "${lang}_en"
    $fromDir = Join-Path $ModelsDir "en_${lang}"
    $toOk   = Test-PairComplete $toDir
    $fromOk = Test-PairComplete $fromDir
    $toExists   = Test-Path $toDir
    $fromExists = Test-Path $fromDir

    if ($toOk -and $fromOk) { 'ok' }
    elseif ($toExists -or $fromExists) { 'partial' }
    else { 'none' }
}

function Get-InstalledLangs {
    $langs = @()
    foreach ($lang in $NonEnLangs) {
        if ((Get-LangStatus $lang) -ne 'none') { $langs += $lang }
    }
    $langs
}

function Format-FileSize($bytes) {
    if ($bytes -ge 1GB) { '{0:N1} GB' -f ($bytes / 1GB) }
    elseif ($bytes -ge 1MB) { '{0:N0} MB' -f ($bytes / 1MB) }
    elseif ($bytes -ge 1KB) { '{0:N0} KB' -f ($bytes / 1KB) }
    else { "$bytes B" }
}

function Get-DirSize($path) {
    if (-not (Test-Path $path)) { return '?' }
    $bytes = (Get-ChildItem -Path $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    Format-FileSize $bytes
}

function Write-InstalledLanguages {
    $langs = @()
    foreach ($lang in $NonEnLangs) {
        if ((Get-LangStatus $lang) -eq 'ok') { $langs += $lang }
    }
    $jsonPath = Join-Path $ScriptDir 'installed-languages.json'
    if ($langs.Count -eq 0) {
        '[]' | Set-Content -Path $jsonPath -NoNewline
    } else {
        $quoted = $langs | ForEach-Object { "`"$_`"" }
        "[$(($quoted -join ','))]" | Set-Content -Path $jsonPath -NoNewline
    }
}

# ── Registry and download ──

function Get-ModelFiles($fromLang, $toLang, $registryData) {
    $bergFrom = Get-BergCode $fromLang
    $bergTo   = Get-BergCode $toLang

    $best = @{}
    foreach ($r in $registryData.data) {
        if ($r.fromLang -ne $bergFrom -or $r.toLang -ne $bergTo) { continue }
        $ver = if ($r.version) { $r.version } else { '0' }
        $key = $r.name
        if (-not $best.ContainsKey($key) -or $ver -gt $best[$key].Version) {
            $best[$key] = @{ Record = $r; Version = $ver }
        }
    }

    $results = @()
    foreach ($entry in $best.GetEnumerator()) {
        $name = $entry.Key
        $r = $entry.Value.Record
        $loc = $r.attachment.location
        $ft = if ($r.fileType) { $r.fileType } else { 'vocab' }
        if ($name -match 'srcvocab') { $ft = 'srcvocab' }
        elseif ($name -match 'trgvocab') { $ft = 'trgvocab' }
        $results += [PSCustomObject]@{ FileType = $ft; Name = $name; Url = "$CDN/$loc" }
    }
    $results
}

function Download-Pair($fromLang, $toLang) {
    $pairKey = "${fromLang}_${toLang}"
    $pairDir = Join-Path $ModelsDir $pairKey

    if (-not (Test-Path $pairDir)) { New-Item -Path $pairDir -ItemType Directory -Force | Out-Null }

    $files = Get-ModelFiles $fromLang $toLang $script:RegistryData
    if ($files.Count -eq 0) {
        Write-Host "    ! No models found for $pairKey, skipping"
        return $false
    }

    $total = $files.Count
    $count = 0
    $manifest = @{}

    foreach ($f in $files) {
        $count++
        $dest = Join-Path $pairDir $f.Name
        if (Test-Path $dest) {
            Write-Host "    [$count/$total] $($f.Name) (cached)"
        } else {
            Write-Host "    [$count/$total] $($f.Name) ... " -NoNewline
            try {
                Invoke-WebRequest -Uri $f.Url -OutFile $dest -UseBasicParsing
                Write-Green 'done'; Write-Host ''
            } catch {
                Write-Host 'FAILED'
                Remove-Item -Path $dest -Force -ErrorAction SilentlyContinue
                return $false
            }
        }
        $manifest[$f.FileType] = $f.Name
    }

    $manifestJson = ($manifest.GetEnumerator() | ForEach-Object { "`"$($_.Key)`":`"$($_.Value)`"" }) -join ','
    "{$manifestJson}" | Set-Content -Path (Join-Path $pairDir 'manifest.json') -NoNewline
    return $true
}

function Download-Language($lang) {
    $name = Get-LangName $lang

    Write-Host ''
    Write-Host '  ' -NoNewline; Write-Bold $name; Write-Host " ($lang)"

    $ok = $true
    Write-Host "  $([char]0x2193) ${lang} -> en"
    if (-not (Download-Pair $lang 'en')) { $ok = $false }

    Write-Host "  $([char]0x2193) en -> ${lang}"
    if (-not (Download-Pair 'en' $lang)) { $ok = $false }

    return $ok
}

# ── UI ──

function Show-Banner {
    $g = "${ESC}[38;2;0;220;130m"
    $b = "${ESC}[1m"
    $r = "${ESC}[0m"
    Write-Host "${g}${b}"
    Write-Host '   ____       _     _____                    _       _'
    Write-Host '  |  _ \ ___ | |_  |_   _| __ __ _ _ __  ___| | __ _| |_ ___'
    Write-Host '  | |_) / _ \| | | | | || ''__/ _` | ''_ \/ __| |/ _` | __/ _ \'
    Write-Host '  |  __/ (_) | | |_| | || | | (_| | | | \__ \ | (_| | ||  __/'
    Write-Host '  |_|   \___/|_|\__, |_||_|  \__,_|_| |_|___/_|\__,_|\__\___|'
    Write-Host '                |___/'
    Write-Host "${r}"
}

function Show-Status {
    $existing = Get-InstalledLangs
    if ($existing.Count -eq 0) {
        Write-Host '  No models installed.'
    } else {
        Write-Host '  Installed languages:'
        foreach ($lang in $existing) {
            $name = Get-LangName $lang
            $st = Get-LangStatus $lang
            if ($st -eq 'ok') {
                $toSize   = Get-DirSize (Join-Path $ModelsDir "${lang}_en")
                $fromSize = Get-DirSize (Join-Path $ModelsDir "en_${lang}")
                Write-Host '    ' -NoNewline; Write-Green "$([char]0x2713)"; Write-Host (' {0,-12} {1} English  ({2} + {3})' -f $name, [char]0x2194, $toSize, $fromSize)
            } else {
                Write-Host '    ' -NoNewline; Write-Yellow '!'; Write-Host (' {0,-12} {1} English  ' -f $name, [char]0x2194) -NoNewline
                Write-Yellow "(incomplete -- run $Self add to repair)"; Write-Host ''
            }
        }
    }
    Write-Host ''
}

function Pick-Languages {
    Write-Host ''
    Write-Host '  Available languages:'
    Write-Host ''

    $total = $NonEnLangs.Count
    $cols = 4
    $rows = [Math]::Ceiling($total / $cols)

    for ($row = 0; $row -lt $rows; $row++) {
        for ($col = 0; $col -lt $cols; $col++) {
            $idx = $col * $rows + $row
            if ($idx -lt $total) {
                $lang = $NonEnLangs[$idx]
                $name = Get-LangName $lang
                $langDir = Join-Path $ModelsDir "${lang}_en"
                $marker = '  '
                if ((Test-Path $langDir) -and @(Get-ChildItem -Path $langDir -Filter '*.bin' -ErrorAction SilentlyContinue).Count -gt 0) {
                    $marker = "${ESC}[32m$([char]0x2713)${ESC}[0m"
                }
                $num = $idx + 1
                Write-Host ('    {0} {1,2}) {2,-14}' -f $marker, $num, $name) -NoNewline
            }
        }
        Write-Host ''
    }
    Write-Host ''
    Write-Host '  Enter numbers separated by spaces, ' -NoNewline; Write-Bold 'all'; Write-Host ' for everything, or ' -NoNewline; Write-Bold 'q'; Write-Host ' to cancel:'
    Write-Host '  > ' -NoNewline
    $selection = Read-Host

    $script:SelectedLangs = @()

    if ($selection -eq 'q' -or $selection -eq 'Q') { return $false }

    if ($selection -eq 'all' -or $selection -eq 'ALL') {
        $script:SelectedLangs = @($NonEnLangs)
        return $true
    }

    foreach ($num in ($selection -split '\s+')) {
        if ($num -match '^\d+$') {
            $n = [int]$num
            if ($n -ge 1 -and $n -le $total) {
                $script:SelectedLangs += $NonEnLangs[$n - 1]
            } else {
                Write-Host "  Skipping invalid selection: $num"
            }
        } elseif ($num -ne '') {
            Write-Host "  Skipping invalid selection: $num"
        }
    }

    if ($script:SelectedLangs.Count -eq 0) {
        Write-Host '  No languages selected.'
        return $false
    }
    return $true
}

# ── Commands ──

function Create-PolytLink {
    $target = Join-Path $ScriptDir 'setup.ps1'
    $linkDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'

    if (-not (Test-Path $linkDir)) {
        $linkDir = Join-Path $env:USERPROFILE '.local\bin'
        if (-not (Test-Path $linkDir)) { New-Item -Path $linkDir -ItemType Directory -Force | Out-Null }
        $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
        if ($userPath -notlike "*$linkDir*") {
            [Environment]::SetEnvironmentVariable('PATH', "$userPath;$linkDir", 'User')
            Write-Host "  Added $linkDir to your PATH (restart terminal to take effect)."
        }
    }

    $cmdPath = Join-Path $linkDir 'polyt.cmd'

    if (Test-Path $cmdPath) {
        Write-Host '  ' -NoNewline; Write-Yellow '!'; Write-Host " $cmdPath already exists -- skipping."
        return
    }

    $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh.exe' } else { 'powershell.exe' }
    $cmdContent = "@echo off`r`n$shell -NoProfile -ExecutionPolicy Bypass -File `"$target`" %*"

    try {
        $cmdContent | Set-Content -Path $cmdPath -Encoding ASCII
        Write-Host '  ' -NoNewline; Write-Green "$([char]0x2713)"; Write-Host ' Installed! You can now use ' -NoNewline; Write-Bold 'polyt'; Write-Host ' from anywhere.'
    } catch {
        Write-Host '  ' -NoNewline; Write-Red "$([char]0x2717)"; Write-Host " Could not create $cmdPath."
        Write-Host "      Try running as Administrator, or create it manually."
    }
}

function cmd_link { Create-PolytLink }

function cmd_unlink {
    $locations = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\polyt.cmd')
        (Join-Path $env:USERPROFILE '.local\bin\polyt.cmd')
    )

    $found = $false
    foreach ($path in $locations) {
        if (Test-Path $path) {
            Remove-Item -Path $path -Force
            Write-Host '  ' -NoNewline; Write-Green "$([char]0x2713)"; Write-Host " Removed $path"
            $found = $true
        }
    }

    if (-not $found) {
        Write-Host '  ' -NoNewline; Write-Yellow '!'; Write-Host ' No polyt shortcut found -- nothing to remove.'
    }
}

function cmd_init {
    Show-Banner

    $hasBin = (Test-Path $ModelsDir) -and @(Get-ChildItem -Path $ModelsDir -Recurse -Filter '*.bin' -ErrorAction SilentlyContinue).Count -gt 0
    if ($hasBin) {
        Write-Host '  Models directory already exists. Use ' -NoNewline; Write-Bold "$Self add"; Write-Host ' to install more languages'
        Write-Host '  or ' -NoNewline; Write-Bold "$Self update"; Write-Host ' to refresh existing models.'
        exit 1
    }

    Write-Host '  Select which languages to install (all translate to/from English).'
    Write-Host '  Each language pair is ~20-50 MB.'

    if (-not (Pick-Languages)) {
        Write-Host '  Setup cancelled.'
        exit 0
    }

    Write-Host ''
    Write-Host '  Fetching model registry...'
    $script:RegistryData = Invoke-RestMethod -Uri $RegistryUrl -UseBasicParsing

    $success = 0; $fail = 0
    foreach ($lang in $script:SelectedLangs) {
        if (Download-Language $lang) { $success++ } else { $fail++ }
    }

    Write-Host ''
    Write-Host '  ────────────────────────────────'
    Write-InstalledLanguages
    Write-Host '  ' -NoNewline; Write-Green 'Done!'; Write-Host " $success languages installed. $fail failed."
    Write-Host ''

    if ($Self -ne 'polyt') {
        Write-Host '  ' -NoNewline; Write-Bold 'Install shortcut?'
        Write-Host ''
        Write-Host '  Create ' -NoNewline; Write-Bold 'polyt'; Write-Host ' command so you can run ' -NoNewline; Write-Bold 'polyt add'; Write-Host ', ' -NoNewline; Write-Bold 'polyt update'; Write-Host ', etc.'
        Write-Host '  from anywhere.'
        Write-Host ''
        Write-Host '  Install polyt shortcut? [Y/n] ' -NoNewline
        $answer = Read-Host
        Write-Host ''
        if ($answer -eq '' -or $answer -match '^[Yy]$') {
            Create-PolytLink
        }
    }
}

function cmd_add {
    Show-Banner

    $installed = Get-InstalledLangs
    if ($installed.Count -eq $NonEnLangs.Count) {
        Write-Host '  ' -NoNewline; Write-Green "$([char]0x2713)"; Write-Host " All $($NonEnLangs.Count) languages are already installed."
        Write-Host '  Use ' -NoNewline; Write-Bold "$Self update"; Write-Host ' to refresh models or ' -NoNewline; Write-Bold "$Self remove"; Write-Host ' to free up space.'
        Write-Host ''
        exit 0
    }

    Show-Status
    Write-Host '  Select additional languages to install:'

    if (-not (Pick-Languages)) {
        Write-Host '  Cancelled.'
        exit 0
    }

    Write-Host ''
    Write-Host '  Fetching model registry...'
    $script:RegistryData = Invoke-RestMethod -Uri $RegistryUrl -UseBasicParsing

    $success = 0; $fail = 0; $skipped = 0
    foreach ($lang in $script:SelectedLangs) {
        $st = Get-LangStatus $lang
        if ($st -eq 'ok') {
            Write-Host ''
            Write-Host '  ' -NoNewline; Write-Dim "$(Get-LangName $lang) already installed, skipping (use update to refresh)"; Write-Host ''
            $skipped++
        } elseif (Download-Language $lang) { $success++ }
        else { $fail++ }
    }

    Write-Host ''
    Write-Host '  ────────────────────────────────'
    Write-InstalledLanguages
    Write-Host '  ' -NoNewline; Write-Green 'Done!'; Write-Host " $success added, $skipped already installed, $fail failed."
    Write-Host '  Reload the extension in chrome://extensions.'
    Write-Host ''
}

function cmd_update {
    Write-Host ''
    Write-Host '  ' -NoNewline; Write-Bold 'PolyTranslate -- Update Models'; Write-Host ''
    Write-Host ''

    $existing = Get-InstalledLangs
    if ($existing.Count -eq 0) {
        Write-Host '  No models installed. Run ' -NoNewline; Write-Bold "$Self init"; Write-Host ' first.'
        exit 1
    }

    Write-Host '  This will re-download the latest models for all installed languages.'
    Write-Host '  Continue? [y/N] ' -NoNewline
    $confirm = Read-Host
    if ($confirm -ne 'y' -and $confirm -ne 'Y') {
        Write-Host '  Cancelled.'
        exit 0
    }

    Write-Host ''
    Write-Host '  Fetching model registry...'
    $script:RegistryData = Invoke-RestMethod -Uri $RegistryUrl -UseBasicParsing

    foreach ($lang in $existing) {
        $toDir   = Join-Path $ModelsDir "${lang}_en"
        $fromDir = Join-Path $ModelsDir "en_${lang}"
        Get-ChildItem -Path $toDir   -Include '*.bin','*.spm' -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force
        Get-ChildItem -Path $fromDir -Include '*.bin','*.spm' -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force
    }

    $success = 0; $fail = 0
    foreach ($lang in $existing) {
        if (Download-Language $lang) { $success++ } else { $fail++ }
    }

    Write-Host ''
    Write-Host '  ────────────────────────────────'
    Write-InstalledLanguages
    Write-Host '  ' -NoNewline; Write-Green 'Done!'; Write-Host " $success languages updated. $fail failed."
    Write-Host '  Reload the extension in chrome://extensions.'
    Write-Host ''
}

function cmd_remove {
    Show-Banner

    $existing = Get-InstalledLangs
    if ($existing.Count -eq 0) {
        Write-Host '  No models installed.'
        exit 0
    }

    Write-Host '  Installed languages:'
    Write-Host ''

    $removable = @()
    $i = 1
    foreach ($lang in $existing) {
        $name = Get-LangName $lang
        Write-Host ('    {0,2}) {1,-12}' -f $i, $name)
        $removable += $lang
        $i++
    }

    Write-Host ''
    Write-Host '  Enter numbers separated by spaces, ' -NoNewline; Write-Bold 'all'; Write-Host ' to remove everything, or ' -NoNewline; Write-Bold 'q'; Write-Host ' to cancel:'
    Write-Host '  > ' -NoNewline
    $selection = Read-Host

    if ($selection -eq 'q' -or $selection -eq 'Q') {
        Write-Host '  Cancelled.'
        exit 0
    }

    $toRemove = @()
    if ($selection -eq 'all' -or $selection -eq 'ALL') {
        $toRemove = @($removable)
    } else {
        foreach ($num in ($selection -split '\s+')) {
            if ($num -match '^\d+$') {
                $n = [int]$num
                if ($n -ge 1 -and $n -le $removable.Count) {
                    $toRemove += $removable[$n - 1]
                }
            }
        }
    }

    if ($toRemove.Count -eq 0) {
        Write-Host '  No languages selected.'
        exit 0
    }

    foreach ($lang in $toRemove) {
        $name = Get-LangName $lang
        $toDir   = Join-Path $ModelsDir "${lang}_en"
        $fromDir = Join-Path $ModelsDir "en_${lang}"
        if (Test-Path $toDir)   { Remove-Item -Path $toDir   -Recurse -Force }
        if (Test-Path $fromDir) { Remove-Item -Path $fromDir -Recurse -Force }
        Write-Host '  Removed ' -NoNewline; Write-Bold $name; Write-Host ''
    }

    if ((Test-Path $ModelsDir) -and @(Get-ChildItem -Path $ModelsDir -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -Path $ModelsDir -Force
    }

    Write-InstalledLanguages

    Write-Host ''
    Write-Host '  ' -NoNewline; Write-Green 'Done!'; Write-Host " $($toRemove.Count) languages removed."
    Write-Host '  Reload the extension in chrome://extensions.'
    Write-Host ''
}

function cmd_status {
    Write-Host ''
    Write-Host '  ' -NoNewline; Write-Bold 'PolyTranslate -- Installed Models'; Write-Host ''
    Write-Host ''
    Show-Status
}

function cmd_help {
    Show-Banner
    Write-Host "  Usage: $Self <command>"
    if ($Self -ne '.\setup.ps1') {
        Write-Host '         .\setup.ps1 <command>'
    }
    Write-Host ''
    Write-Host '  Commands:'
    Write-Host '    init     First-time setup -- choose and download language models'
    Write-Host '    add      Download additional language models'
    Write-Host '    update   Re-download latest versions of installed models'
    Write-Host '    remove   Remove installed language models'
    Write-Host '    status   Show which models are installed'
    Write-Host '    link     Create the polyt shortcut'
    Write-Host '    unlink   Remove the polyt shortcut'
    Write-Host '    help     Show this message'
    Write-Host ''
    Write-Host '  Examples:'
    Write-Host "    $Self init          # Interactive first-time setup"
    Write-Host "    $Self add           # Add more languages later"
    Write-Host "    $Self update        # Refresh all installed models"
    Write-Host "    $Self remove        # Remove languages you don't need"
    Write-Host ''
}

# ── Main ──

switch ($Command) {
    'init'   { cmd_init }
    'add'    { cmd_add }
    'update' { cmd_update }
    'remove' { cmd_remove }
    'status' { cmd_status }
    'link'   { cmd_link }
    'unlink' { cmd_unlink }
    'help'   { cmd_help }
    default  {
        Write-Host "Unknown command: $Command"
        cmd_help
        exit 1
    }
}
