<#
.SYNOPSIS
  Builds the SIGNED Preyone release APK and verifies it against the certificate
  the app is already published with.

.DESCRIPTION
  A release APK is only useful if it is signed with the SAME certificate as the
  build already on users' phones. A differently-signed APK fails to install with
  INSTALL_FAILED_UPDATE_INCOMPATIBLE, and an unsigned one will not install at
  all. Rather than trusting the build to be right, this script fails loudly if
  the produced artifact's certificate does not match the expected fingerprint.

  Signing values are read from the env file (default
  %USERPROFILE%\.preyone\preyone-release.env) so no secret is ever passed on a
  command line, where it would land in shell history and process listings.

.PARAMETER ExpectedSha256
  The certificate fingerprint the published app is signed with. The build is
  rejected if it differs.

.EXAMPLE
  .\build-release.ps1
  .\build-release.ps1 -Flavour release -ExpectedSha256 'AB:CD:...'
#>
[CmdletBinding()]
param(
  [string]$Flavour = 'release',
  [string]$ExpectedSha256 = '97:F2:AD:1A:65:6F:5C:80:0F:07:90:33:44:05:80:1E:57:84:BD:13:A9:DF:79:A5:84:6F:7B:35:82:E0:22:8F'
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
Push-Location $appRoot
try {
  # keytool prints colons, apksigner prints bare hex. Compare on one canonical
  # form so a correct build is not rejected over punctuation.
  function ConvertTo-NormalizedFingerprint([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return '' }
    return ($value -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
  }
  $expectedCanonical = ConvertTo-NormalizedFingerprint $ExpectedSha256

  $envFile = Join-Path $HOME '.preyone\preyone-release.env'
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Signing env file not found: $envFile"
  }

  # Load the four PREYONE_RELEASE_* values into THIS process only.
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      [Environment]::SetEnvironmentVariable(
        $matches[1], $matches[2].Trim().Trim('"').Trim("'"), 'Process')
    }
  }

  $store = [Environment]::GetEnvironmentVariable('PREYONE_RELEASE_STORE_FILE', 'Process')
  $storePass = [Environment]::GetEnvironmentVariable('PREYONE_RELEASE_STORE_PASSWORD', 'Process')
  $keyPass = [Environment]::GetEnvironmentVariable('PREYONE_RELEASE_KEY_PASSWORD', 'Process')
  $alias = [Environment]::GetEnvironmentVariable('PREYONE_RELEASE_KEY_ALIAS', 'Process')
  foreach ($pair in @(@{n = 'STORE_FILE'; v = $store }, @{n = 'KEY_ALIAS'; v = $alias },
      @{n = 'STORE_PASSWORD'; v = $storePass }, @{n = 'KEY_PASSWORD'; v = $keyPass })) {
    if ([string]::IsNullOrWhiteSpace($pair.v)) {
      throw "PREYONE_RELEASE_$($pair.n) is not set in $envFile"
    }
  }
  if (-not (Test-Path -LiteralPath $store)) { throw "Keystore not found: $store" }

  Write-Host "==> Verifying the keystore certificate matches the published app"
  $keytool = (Get-Command keytool -ErrorAction SilentlyContinue).Source
  if (-not $keytool) {
    $keytool = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk" -Recurse -Filter 'keytool.exe' -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $keytool) { throw 'keytool not found' }
  $certText = & $keytool -list -v -keystore $store -storepass $storePass -alias $alias 2>&1
  $storeSha = ($certText | Select-String -Pattern 'SHA256:\s*([0-9A-F:]+)' | Select-Object -First 1)
  if (-not $storeSha) { throw 'Could not read a SHA-256 fingerprint from the keystore' }
  $storeSha = $storeSha.Matches[0].Groups[1].Value
  if ((ConvertTo-NormalizedFingerprint $storeSha) -ne $expectedCanonical) {
    throw "Keystore certificate does NOT match the published app.`n  keystore: $storeSha`n  expected: $ExpectedSha256`nRefusing to build: a differently-signed APK cannot upgrade the installed app."
  }
  Write-Host "    keystore certificate OK"

  Write-Host "==> Building the $Flavour APK"
  # Gradle writes progress and plugin warnings to stderr. With
  # ErrorActionPreference=Stop that would abort on a harmless warning, so the
  # invocation is wrapped and judged on its exit code instead.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & flutter build apk --$Flavour 2>&1 | ForEach-Object { Write-Host "    $_" }
  $buildExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($buildExit -ne 0) { throw "flutter build apk --$Flavour failed (exit $buildExit)" }

  $apk = "build\app\outputs\flutter-apk\app-$Flavour.apk"
  if (-not (Test-Path -LiteralPath $apk)) { throw "APK not produced at $apk" }

  Write-Host "==> Verifying the APK signature"
  $apksigner = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\build-tools" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $apksigner) { throw 'apksigner not found in the Android SDK' }
  $prevEap2 = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $verify = & $apksigner verify --verbose --print-certs $apk 2>&1
  $verifyExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap2
  if ($verifyExit -ne 0 -or ($verify -join "`n") -match 'DOES NOT VERIFY') {
    throw "The built APK does not verify: an unsigned or badly signed release will not install."
  }
  $apkSha = ($verify | Select-String -Pattern 'certificate SHA-256 digest:\s*([0-9a-fA-F:]+)' | Select-Object -First 1)
  if (-not $apkSha) { throw 'Could not read the APK certificate fingerprint' }
  $apkSha = $apkSha.Matches[0].Groups[1].Value
  if ((ConvertTo-NormalizedFingerprint $apkSha) -ne $expectedCanonical) {
    throw "The APK is signed with the WRONG certificate.`n  apk:     $apkSha`n  expected: $ExpectedSha256"
  }

  $hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash
  Write-Host ''
  Write-Host 'BUILD OK'
  Write-Host "  apk:      $apk"
  Write-Host "  size:     $((Get-Item -LiteralPath $apk).Length) bytes"
  Write-Host "  cert:     $apkSha  (matches the published app)"
  Write-Host "  sha256:   $hash"
  $apkSha
  $hash
}
finally {
  Pop-Location
}
