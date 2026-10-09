$ErrorActionPreference = 'Stop'
$envFile = Join-Path $HOME '.preyone\preyone-release.env'
if (-not (Test-Path $envFile)) { Write-Error "Missing release credential file: $envFile"; exit 1 }
Get-Content $envFile | ForEach-Object { if ($_ -match '^([A-Za-z0-9_]+)=(.*)$') { Set-Item "Env:$($matches[1])" $matches[2] } }
$appDir = Join-Path $PSScriptRoot '..\bus-ticket-app'
Push-Location $appDir
try {
    & flutter build apk --release
    if ($LASTEXITCODE -ne 0) { throw "flutter build failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}
$apk = Join-Path $appDir 'build\app\outputs\flutter-apk\app-release.apk'
$buildTools = "$env:LOCALAPPDATA\Android\Sdk\build-tools"
$apksigner = Get-ChildItem $buildTools -Recurse -Filter apksigner.bat | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
& $apksigner verify --print-certs $apk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed" }
Write-Host "SIGNED APK: $apk"