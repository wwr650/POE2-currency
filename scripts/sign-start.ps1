# ============================================================
#  Sign start.ps1 with a local self-signed code signing cert.
#
#  Why start.ps1 and not start.bat: Windows has no Authenticode
#  SIP for batch files, so Set-AuthenticodeSignature always
#  fails on .bat ("the trust provider does not support the
#  subject form"). start.bat is a thin ASCII shim that verifies
#  this signature and refuses tampered launchers.
#
#  Steps:
#    1. find or create a self-signed code signing certificate
#       (CN=PoE2-Currency-Local, SHA-256, 5 years) in
#       Cert:\CurrentUser\My;
#    2. sign ..\start.ps1;
#    3. export the public key to PoE2-Currency-Local.cer and
#       trust it in the CURRENT USER Root + TrustedPublisher
#       stores (no admin needed) so the status becomes Valid;
#    4. verify and print the result.
#
#  Re-run this script whenever start.ps1 changes (any byte
#  edit invalidates the signature -> HashMismatch).
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File scripts\sign-start.ps1
# ============================================================
param(
    [string]$Subject = "CN=PoE2-Currency-Local",
    [string]$FilePath = (Join-Path $PSScriptRoot "..\start.ps1")
)

$ErrorActionPreference = "Stop"
$FilePath = (Resolve-Path $FilePath).Path
Write-Host "target file : $FilePath"

# ------------------------------------------------------------ 1. certificate
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt (Get-Date) } |
    Select-Object -First 1
if (-not $cert) {
    Write-Host "creating self-signed code signing certificate: $Subject"
    $cert = New-SelfSignedCertificate `
        -Subject $Subject `
        -Type CodeSigningCert `
        -HashAlgorithm SHA256 `
        -KeyLength 3072 `
        -NotAfter (Get-Date).AddYears(5) `
        -CertStoreLocation Cert:\CurrentUser\My
} else {
    Write-Host "reusing certificate (thumbprint $($cert.Thumbprint), expires $($cert.NotAfter))"
}

# ------------------------------------------------------------ 2. sign
$signResult = Set-AuthenticodeSignature -FilePath $FilePath -Certificate $cert
if ($signResult.Status -notin @("Signed", "Valid")) {
    Write-Host "signing FAILED: $($signResult.StatusMessage)"
    exit 1
}
Write-Host "signed. status: $($signResult.Status)"

# ------------------------------------------------------------ 3. trust the cert (current user only)
$cerPath = Join-Path (Split-Path $FilePath) "PoE2-Currency-Local.cer"
[IO.File]::WriteAllBytes($cerPath, $cert.Export("Cert"))
Write-Host "public key exported: $cerPath"

foreach ($store in @("Root", "TrustedPublisher")) {
    $already = Get-ChildItem "Cert:\CurrentUser\$store" |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
    if (-not $already) {
        # certutil -addstore is non-interactive; user scope only, no admin
        & certutil.exe -addstore -user $store $cerPath | Out-Null
        Write-Host "cert added to current-user store: $store"
    } else {
        Write-Host "cert already in current-user store: $store (skipped)"
    }
}

# ------------------------------------------------------------ 4. verify
$verify = Get-AuthenticodeSignature -FilePath $FilePath
Write-Host ""
Write-Host "================ verification ================"
Write-Host "status  : $($verify.Status)"
Write-Host "message : $($verify.StatusMessage)"
if ($verify.SignerCertificate) { Write-Host "signer  : $($verify.SignerCertificate.Subject)" }
Write-Host "=============================================="
if ($verify.Status -ne "Valid") { exit 1 }
