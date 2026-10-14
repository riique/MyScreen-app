# Gera o instalador e publica no servidor por SSH (rota /downloads/ do Caddy).
# Uso: npm run publish:desktop   (ou .\scripts\publish-desktop.ps1 -SshHost myscreen)
param(
  [string]$SshHost = "ubuntu",
  [string]$RemoteDir = "/opt/myscreen/releases"
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

npm run dist
if ($LASTEXITCODE -ne 0) { throw "build falhou" }

$ver = (Get-Content package.json | ConvertFrom-Json).version
$out = "release"
$exe = "MyScreen-Setup-$ver.exe"
if (-not (Test-Path "$out/$exe")) { throw "nao encontrei $out/$exe" }

# Binarios primeiro, feed por ultimo: um cliente que le o latest.yml novo
# precisa encontrar o .exe que ele aponta.
scp "$out/$exe" "$out/$exe.blockmap" "${SshHost}:$RemoteDir/"
if ($LASTEXITCODE -ne 0) { throw "scp do instalador falhou" }
scp "$out/latest.yml" "${SshHost}:$RemoteDir/latest.yml.tmp"
if ($LASTEXITCODE -ne 0) { throw "scp do feed falhou" }
# O mv e atomico: nenhum cliente le um latest.yml pela metade.
ssh $SshHost "cd $RemoteDir && cp $exe MyScreen-Setup-latest.exe && mv latest.yml.tmp latest.yml"
if ($LASTEXITCODE -ne 0) { throw "ssh falhou" }

Write-Host "Publicado: $exe (feed atualizado)"
