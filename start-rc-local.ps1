$ErrorActionPreference = "Stop"

$nodeDirectory = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
$pnpmPath = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"

if (-not (Test-Path -LiteralPath $pnpmPath)) {
  throw "Codex bundled pnpm was not found: $pnpmPath"
}

$env:PATH = "$nodeDirectory;$env:PATH"
$temporaryEnvFile = Join-Path $env:TEMP "apt-price-viewer-rc-$PID.dev.vars"
$secureKey = Read-Host "공공데이터포털 일반 인증키(Decoding)" -AsSecureString
$keyPointer = [IntPtr]::Zero

try {
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $serviceKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($temporaryEnvFile, "MOLIT_SERVICE_KEY=$serviceKey", $utf8WithoutBom)

  Write-Host ""
  Write-Host "RC 테스트 주소: http://127.0.0.1:8788/?apiProxy=1"
  Write-Host "서버를 종료하려면 이 창에서 Ctrl+C를 누르세요."
  Write-Host ""

  & $pnpmPath dlx wrangler@4.114.0 pages dev $PSScriptRoot `
    --port 8788 `
    --ip 127.0.0.1 `
    --compatibility-date 2026-07-29 `
    --d1 SUPPLY_DB `
    --env-file $temporaryEnvFile `
    --persist-to (Join-Path $PSScriptRoot ".wrangler\state")
} finally {
  if ($keyPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
  $serviceKey = $null
  if (Test-Path -LiteralPath $temporaryEnvFile) {
    Remove-Item -LiteralPath $temporaryEnvFile -Force
  }
}
