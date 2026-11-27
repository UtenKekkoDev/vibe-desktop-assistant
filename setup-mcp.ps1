param([string]$Uv = 'uv')
$ErrorActionPreference = 'Stop'
$env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.runtime/cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.runtime/python'
$venv = Join-Path $PSScriptRoot '.runtime/venv'
if (!(Test-Path (Join-Path $venv 'Scripts/python.exe'))) {
    & $Uv venv --python 3.14 $venv
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
& $Uv pip install --python (Join-Path $venv 'Scripts/python.exe') 'windows-mcp==0.8.9'
exit $LASTEXITCODE
