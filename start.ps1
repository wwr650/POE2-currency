# ============================================================
#  PoE2 currency dashboard - signed launcher
#  This file carries the Authenticode signature (see
#  scripts\sign-start.ps1).  start.bat is a thin ASCII shim
#  that verifies this signature before delegating here.
#
#  Usage: start.ps1 [offline] [no-browser] [reload] [--port N]
# ============================================================
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Pause-Exit([int]$code, [string]$msg) {
    Write-Host ""
    Write-Host $msg
    try { Read-Host "Press Enter to exit" } catch {}
    exit $code
}

# --- integrity check ---------------------------------------
# Mirrors the start.bat gate: a Valid signature runs silently,
# an unsigned working copy (fresh clone) warns, anything else
# (HashMismatch / NotTrusted / UnknownError...) is refused.
$sig = Get-AuthenticodeSignature $PSCommandPath
if ($sig.Status -eq "NotSigned") {
    Write-Host "[WARN] start.ps1 is NOT signed - running an unverified copy."
} elseif ($sig.Status -ne "Valid") {
    Pause-Exit 2 "[FAIL] signature check failed: $($sig.StatusMessage)"
}

# --- locate a working Python (>= 3.9) ----------------------
# Mirrors the legacy start.bat order (py -> python) but also
# proves the candidate really runs: the WindowsApps "python.exe"
# store-alias stub is skipped, every candidate is probed (this
# also accepts pyenv-win python.bat shims), and the project's
# own .venv is the final fallback - so a broken PATH entry can
# never hang the launcher silently.
function Probe-Python([string]$Exe, [string[]]$PreArgs) {
    $a = @()
    if ($PreArgs) { $a += $PreArgs }
    $a += @("-c", "import sys;print(sys.version_info[0]*100+sys.version_info[1])")
    try {
        $out = & $Exe @a 2>$null | Select-Object -Last 1
        if ($LASTEXITCODE -eq 0 -and $out -match '^\d{3,4}$') {
            return [int]$out -ge 309
        }
    } catch { }
    return $false
}

$candidates = @()
foreach ($name in @("py", "python", "python3")) {
    foreach ($cmd in (Get-Command $name -All -ErrorAction SilentlyContinue)) {
        $src = $cmd.Source
        if (-not $src) { continue }
        # skip the Microsoft Store app-execution-alias stub
        if ($src -match '\\WindowsApps\\') { continue }
        # skip pyenv "no version selected" placeholder shims later via probe
        $pre = @()
        if ($name -eq "py") { $pre = @("-3") }
        $candidates += @{ Exe = $src; Pre = $pre }
    }
}
# final fallback: the project's own virtual environment
$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (Test-Path $venvPy) {
    $candidates += @{ Exe = $venvPy; Pre = @() }
}

$boot = $null
foreach ($cand in $candidates) {
    if (Probe-Python $cand.Exe $cand.Pre) { $boot = $cand; break }
}
if (-not $boot) {
    Pause-Exit 1 "[ERROR] No usable Python 3.9+ found.`n        Install Python from https://www.python.org/downloads/`n        and tick 'Add Python to PATH', or disable the Windows`n        'App execution alias' for python.exe in Settings."
}

# --- run launcher.py ---------------------------------------
$launcher = Join-Path $PSScriptRoot "launcher.py"
if ($boot.Pre.Count) {
    & $boot.Exe $boot.Pre[0] $launcher @args
} else {
    & $boot.Exe $launcher @args
}
$rc = $LASTEXITCODE
if ($rc -ne 0) {
    Write-Host ""
    try { Read-Host "Process exited with code $rc - press Enter to close" } catch {}
}
exit $rc

# SIG # Begin signature block
# MIIG+QYJKoZIhvcNAQcCoIIG6jCCBuYCAQExCzAJBgUrDgMCGgUAMGkGCisGAQQB
# gjcCAQSgWzBZMDQGCisGAQQBgjcCAR4wJgIDAQAABBAfzDtgWUsITrck0sYpfvNR
# AgEAAgEAAgEAAgEAAgEAMCEwCQYFKw4DAhoFAAQU+8prnERhxmMfDElY59RBHPGY
# OCWgggQQMIIEDDCCAnSgAwIBAgIQFS9dngnvY6ZIbUTa5vutDjANBgkqhkiG9w0B
# AQsFADAeMRwwGgYDVQQDDBNQb0UyLUN1cnJlbmN5LUxvY2FsMB4XDTI2MTAxMzEw
# NTIzNVoXDTMxMTAxMzExMDIzNVowHjEcMBoGA1UEAwwTUG9FMi1DdXJyZW5jeS1M
# b2NhbDCCAaIwDQYJKoZIhvcNAQEBBQADggGPADCCAYoCggGBAMr22r5eOWU6rDe6
# Hp01keeTjjuQdRwc9bZkFiYMJj/gL41Z/Q2kkMIixA3loBVXS9uOCJIvicQRuglR
# D6J+uXS8yO2dpS3MCX0NUQBGfwodtz7MQ/b4bT438ar5zE4CC330XAusqDFjS5ag
# G27+dxvivtW7XX6ZYD9gnu1Nam2t9Fud32q6ZkCX3MpzJcq/S0+H1uTD9brYwJF1
# cYn6rhcuS7tyx8EzcS3wIyU+eUZ+bDQ/O4tMT/LAHsp+rMWtZYU+o0xoB8YgV9wb
# oBLNYPDCBvC7zkEts+YINqafQmHQ95edHcF95ydY/18T9qLaVpPz0rKFlsf/mtaE
# NJAJ7FJTIVuZLRA27MrjsaXNxetzdFf0HbuCsoI/vjNl4BZhEmPexjF/gqb8JZHH
# GxCAQHnXdrnJ0uFIBdCMKo9vbgeA7Jv3X6eqis7VofLLG8ALLiV47lo7kkUysfiF
# PZCdua/CNa1vMzvgmgLknlc+DR3JwbrRTs4YU3p4PhP8ODhoFQIDAQABo0YwRDAO
# BgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwMwHQYDVR0OBBYEFFUz
# BWwr9qJGd3E5gtdgJxoS83R0MA0GCSqGSIb3DQEBCwUAA4IBgQBFSxb/5c5g0VfU
# d+2E0HdT2H3lJqhsx+8qvpJyMg9u4rMuQ8Vk3Ia8rcXlK3Pbt3nYRwSxzlkGo295
# 53WNJC7poetXqZ8X0EwhdiIy2Rhq2JnOqZddlyXvdJiqrteD9nTfoIAun4k5LocC
# bAhvxzE3JvSvkwhZwJnL0YsCCYPv9v8nGvB2Jlq76o5GiHavQXplZ4Yorfp3H0zQ
# divqo/CHw80zSdjxKnlfeY4i5czB8G/QwrS46xdLKDkSNO4lBcFLobVX59UB5k/G
# mM9IQRukYpKfJI57w2hB6dtqu8rGdUAWA3uRmO1xXETNF2UZJjDltcGkxbR0kVER
# kk3g4n9pW3YgXUeoDx2zBBdyb0Z3JmYa76LLON00czyp16hU1YftWPzXy2HOMNAu
# XOtcxNbzu9wGhc/PQnznwfaq0bEBUTtGNLzrMtwfg6LgZ3UhPO9PGgSb/m+ouox5
# 2m2f29+I3yP+VBPDWibkRwreLZVKh0IhsSGN/Ty001lp6/EA9GMxggJTMIICTwIB
# ATAyMB4xHDAaBgNVBAMME1BvRTItQ3VycmVuY3ktTG9jYWwCEBUvXZ4J72OmSG1E
# 2ub7rQ4wCQYFKw4DAhoFAKB4MBgGCisGAQQBgjcCAQwxCjAIoAKAAKECgAAwGQYJ
# KoZIhvcNAQkDMQwGCisGAQQBgjcCAQQwHAYKKwYBBAGCNwIBCzEOMAwGCisGAQQB
# gjcCARUwIwYJKoZIhvcNAQkEMRYEFHu4CBI9L+7YI0/aP0/q5qfdYgILMA0GCSqG
# SIb3DQEBAQUABIIBgDX7eD7KRfK6zElVeBmvAMt7r+8OGgyi3RRxqGFmujwiD+2s
# HbTViTOYWt3NzzCPKqxi5Ji5qPr/62bOqvgMicjMOPhnL0J3XmoE/cfgm02t1QEb
# FO1hc/VYEt/aBT6ZRAD93Kz/gJAatxhljB5rJVXmKbo6sCOR9BbkGXhjm2Wl9ku4
# a/c/i12eI5gInSjSZTq0m2sNN/VQs+XNsU7DayfzeG5ZolbzXp2EZQNbDwA4rdek
# Rdci5CFw9G8kOnlv22ZxoNgUCct7eUpI2iEs8SM2sXXseHrOPKsThP9J1m/6sTAV
# U4t6MvCSjGMQL8G29x7iSgq8XmXXXQ9ZZwAnCK7KlbAAhM/BYcPjbPjK5DzKQnVR
# 5TLe4+PI+TaNGGcw51OWxfeHUx3oy5AuesYI9S3jRZXt5o2qXBei8GPu0S2PhG4N
# d2gA8THLWqegz49WpZTVKGojdFEi32PnoIrvkk4oDnP4YSELt4fOQ6UeM7WwY/9l
# a71IVkAeOV1g9f+ZWA==
# SIG # End signature block
