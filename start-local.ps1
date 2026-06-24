$ErrorActionPreference = "Stop"

$port = 5179
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

Write-Host "Soundboks_FOH local demo"
Write-Host "URL: http://127.0.0.1:$port/"
Write-Host "Demo mode: http://127.0.0.1:$port/?demo=1"
Write-Host "Stop with Ctrl+C."

python -m http.server $port --bind 127.0.0.1
