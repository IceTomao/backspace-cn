param([switch]$UpdateLocks)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$private = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'BackspaceAndroidSigning'))
if ($private.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Signing files must be outside the source and delivery directories.'
}
function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed ($LASTEXITCODE)" }
}
New-Item -ItemType Directory -Force -Path $private | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Invoke-Checked 'icacls.exe' @($private, '/inheritance:r', '/grant:r', "*${sid}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F') | Out-Null
$key = Join-Path $private 'backspace-release.p12'
$credentials = Join-Path $private 'signing.json'
if ((Test-Path -LiteralPath $key) -and !(Test-Path -LiteralPath $credentials)) {
    throw 'Existing signing key has no password file. Restore the private backup; do not replace the key.'
}
if (!(Test-Path -LiteralPath $credentials)) {
    $bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    @{ password = [Convert]::ToBase64String($bytes); alias = 'backspace' } |
        ConvertTo-Json | Set-Content -LiteralPath $credentials -Encoding utf8
}
$secrets = Get-Content -Raw -LiteralPath $credentials | ConvertFrom-Json
$env:BACKSPACE_ANDROID_KEYSTORE = $key
$env:BACKSPACE_ANDROID_STORE_PASSWORD = $secrets.password
try {
    if (!(Test-Path -LiteralPath $key)) {
        Invoke-Checked (Join-Path $env:JAVA_HOME 'bin\keytool.exe') @(
            '-genkeypair', '-keystore', $key, '-storetype', 'PKCS12',
            '-storepass:env', 'BACKSPACE_ANDROID_STORE_PASSWORD',
            '-keypass:env', 'BACKSPACE_ANDROID_STORE_PASSWORD',
            '-alias', 'backspace', '-keyalg', 'RSA', '-keysize', '3072',
            '-validity', '10000', '-dname', 'CN=Backspace Android, OU=Private Distribution, O=Backspace, C=CN',
            '-noprompt'
        )
    }
    @'
# Private Android Signing Backup
Keep backspace-release.p12 and signing.json together in a private offline backup.
Do not share these files with APK recipients, upload them, or include them in source archives.
Every future update for me.kevz.backspace must use this same key.
Losing the key prevents a same-identity in-place update. Do not regenerate it for later releases.
This directory is restricted to this Windows user and SYSTEM.
'@ | Set-Content -LiteralPath (Join-Path $private 'BACKUP-README.md') -Encoding utf8
    if (!$env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
    Push-Location $root
    try {
        Invoke-Checked 'node.exe' @('scripts/android-icons.mjs')
        Invoke-Checked 'pnpm.cmd' @('--filter', '@backspace/web', 'build:android')
        Invoke-Checked 'pnpm.cmd' @('--filter', '@backspace/android', 'exec', 'cap', 'sync', 'android')
        $arguments = @('-p', 'packages/android/android', ':app:testDebugUnitTest', ':app:assembleRelease', '--console=plain')
        if ($UpdateLocks) { $arguments += '--write-locks' }
        Invoke-Checked (Join-Path $root 'packages/android/android/gradlew.bat') $arguments
    } finally { Pop-Location }
} finally {
    Remove-Item Env:\BACKSPACE_ANDROID_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\BACKSPACE_ANDROID_KEYSTORE -ErrorAction SilentlyContinue
    $secrets = $null
}
Write-Output 'Release build complete. Private signing material is outside the repository in LOCALAPPDATA\BackspaceAndroidSigning.'
