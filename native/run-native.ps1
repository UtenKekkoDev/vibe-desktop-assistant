$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:VIBE_DESKTOP_TTS_RUNTIME_DIR = Join-Path $PSScriptRoot 'tts'
cargo run --locked --bin vibe-desktop-assistant
exit $LASTEXITCODE
