# Inicia o Habblaud adaptado para Antigravity (nativo no Windows, sem Docker/WSL)
Set-Location $PSScriptRoot
$env:HABBLAUD_WORLD = "0"
$env:HABBLAUD_PORT = "4747"
Write-Host "Iniciando Habblaud (Antigravity Edition) em http://localhost:4747 ..." -ForegroundColor Cyan
node dist\server\index.js
