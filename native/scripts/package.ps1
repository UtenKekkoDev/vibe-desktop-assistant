param(
    [string]$BinaryDir = 'target/release',
    [string]$OutputDir = 'dist'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$assistantRoot = Split-Path $projectRoot -Parent
$binaryRoot = (Resolve-Path -LiteralPath $BinaryDir).Path
$outputRoot = [IO.Path]::GetFullPath($OutputDir)
$bundle = Join-Path $outputRoot 'vibe-desktop-assistant-windows-x64'
if (Test-Path -LiteralPath $bundle) { throw "Bundle already exists; choose a fresh OutputDir: $bundle" }
if (!(Test-Path -LiteralPath (Join-Path $binaryRoot 'vibe-desktop-assistant.exe'))) { throw 'Build the release executable first.' }
New-Item -ItemType Directory -Path (Join-Path $bundle 'tts/faster_qwen3_tts') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $binaryRoot 'vibe-desktop-assistant.exe') -Destination $bundle
Get-ChildItem -LiteralPath $binaryRoot -Filter '*.dll' -File | Copy-Item -Destination $bundle
foreach ($file in @('LICENSE','THIRD_PARTY_NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $bundle
}
# The native fourth mode and the documented CLI share this release-local backend.
# Use an explicit manifest so personal settings, keys and virtual environments stay out.
foreach ($file in @(
    'README.md','PRD.md','开发路线.md','start-voice.cmd',
    'native-backend.mjs','assistant.mjs','session.mjs','intent.mjs','budget.mjs','verify-intent.mjs',
    'desktop.py','desktop_bridge.py','wechat_contacts.py','ai_chat.py','setup-mcp.ps1',
    'steam_search.py','setup-ufo.ps1','ufo-requirements.txt',
    'voice.mjs','voice-session.mjs','voice_input.py','voice_feedback.py','setup-voice.ps1'
)) {
    Copy-Item -LiteralPath (Join-Path $assistantRoot $file) -Destination $bundle -ErrorAction Stop
}
New-Item -ItemType Directory -Path (Join-Path $bundle 'docs'),(Join-Path $bundle 'assets') | Out-Null
foreach ($file in @('MODELS.md','MODELS.zh-CN.md','TTS.md')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "docs/$file") -Destination (Join-Path $bundle 'docs')
}
foreach ($file in @('app-icon.png', 'result-card.png')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "assets/$file") -Destination (Join-Path $bundle 'assets')
}
foreach ($file in @('worker.py','audio_output.py','qwen_stream.py','turbo_stream.py','runtime.example.json','requirements.txt','Faster-Qwen-LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "tts/$file") -Destination (Join-Path $bundle 'tts')
}
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tts/faster_qwen3_tts') -Filter '*.py' -File |
    Copy-Item -Destination (Join-Path $bundle 'tts/faster_qwen3_tts')
$zip = "$bundle.zip"
Compress-Archive -LiteralPath $bundle -DestinationPath $zip
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$zip.sha256", "$hash  $([IO.Path]::GetFileName($zip))`n", [Text.Encoding]::ASCII)
Write-Output $zip
