param([string]$Repository = 'IceTomao/backspace-cn')
$ErrorActionPreference = 'Stop'
$privatePath = Join-Path $env:LOCALAPPDATA 'BackspaceAndroidSigning'
$keyPath = Join-Path $privatePath 'backspace-release.p12'
$passwordPath = Join-Path $privatePath 'signing.json'
if (!(Test-Path -LiteralPath $keyPath) -or !(Test-Path -LiteralPath $passwordPath)) {
    throw 'Restore or initialize the fixed signing key before configuring GitHub.'
}
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (!$gh) {
    $gh = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'BackspaceBuildTools/github-cli') -Filter gh.exe -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (!$gh) { throw 'Install GitHub CLI, run gh auth login, then rerun this script.' }
$previousToken = $env:GH_TOKEN
$previousPrompt = $env:GIT_TERMINAL_PROMPT
$previousInteractive = $env:GCM_INTERACTIVE
try {
    if (!$env:GH_TOKEN) {
        & $gh auth status *> $null
        if ($LASTEXITCODE -ne 0) {
            $env:GIT_TERMINAL_PROMPT = '0'
            $env:GCM_INTERACTIVE = 'never'
            $credentialLines = @('protocol=https', 'host=github.com', '') | git credential fill 2>$null
            $passwordLine = $credentialLines | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
            if (!$passwordLine) { throw 'Run gh auth login, then rerun this script.' }
            $env:GH_TOKEN = $passwordLine.Substring(9)
        }
    }
    $credentials = Get-Content -Raw -LiteralPath $passwordPath | ConvertFrom-Json
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyPath)) |
        & $gh secret set BACKSPACE_ANDROID_KEYSTORE_BASE64 --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the GitHub keystore secret. Check repository administration permissions.' }
    $credentials.password | & $gh secret set BACKSPACE_ANDROID_STORE_PASSWORD --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the GitHub signing password secret.' }
    & $gh secret list --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify GitHub secrets.' }
    Write-Output 'GitHub signing secrets configured using the fixed local release key.'
} finally {
    $env:GH_TOKEN = $previousToken
    $env:GIT_TERMINAL_PROMPT = $previousPrompt
    $env:GCM_INTERACTIVE = $previousInteractive
    $credentialLines = $null; $passwordLine = $null; $credentials = $null
}
