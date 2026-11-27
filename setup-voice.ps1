param([string]$Uv = 'uv', [string]$ModelDir)
$ErrorActionPreference = 'Stop'
$env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.runtime/cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.runtime/python'
$venv = Join-Path $PSScriptRoot '.runtime/voice'
$python = Join-Path $venv 'Scripts/python.exe'
if (!(Test-Path -LiteralPath $python)) {
    & $Uv venv --python 3.12 $venv
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
& $Uv pip install --python $python 'sherpa-onnx==2.0.2' 'sounddevice==0.5.6' 'numpy==2.5.5'
if ($LASTEXITCODE) { exit $LASTEXITCODE }
if ($ModelDir) {
    $files = @('model.int8.onnx', 'tokens.txt')
    foreach ($file in $files) {
        if (!(Test-Path -LiteralPath (Join-Path $ModelDir $file) -PathType Leaf)) { throw "Missing $file in model directory" }
    }
    $destination = Join-Path $PSScriptRoot '.runtime/sensevoice'
    [void](New-Item -ItemType Directory -Path $destination -Force)
    foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $ModelDir $file) -Destination $destination -Force }
}
