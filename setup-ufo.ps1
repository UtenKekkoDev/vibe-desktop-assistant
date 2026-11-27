param([string]$Uv = 'uv')
$ErrorActionPreference = 'Stop'
$revision = 'eae3c0a8d168c47cb10df0652e293e092eda1078'
$runtime = Join-Path $PSScriptRoot '.runtime'
$repo = Join-Path $runtime 'ufo'
$marker = Join-Path $repo '.ufo-revision'
$env:UV_CACHE_DIR = Join-Path $runtime 'cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtime 'python'
if (!(Test-Path $repo)) {
    git init -q $repo
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    git -C $repo remote add origin https://github.com/microsoft/UFO.git
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
if (!(Test-Path $marker) -or (Get-Content -Raw $marker).Trim() -ne $revision) {
    git -C $repo sparse-checkout set ufo aip config
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    git -C $repo fetch --depth 1 --filter=blob:none origin $revision
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    git -C $repo checkout --detach $revision
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    Set-Content $marker $revision -Encoding ascii
}
$venv = Join-Path $runtime 'ufo-env'
$python = Join-Path $venv 'Scripts/python.exe'
if (!(Test-Path $python)) {
    & $Uv venv --python 3.11.18 $venv
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
& $Uv pip install --python $python -r (Join-Path $PSScriptRoot 'ufo-requirements.txt')
exit $LASTEXITCODE
