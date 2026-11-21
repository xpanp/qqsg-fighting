param([string]$HostAlias = 'tx')
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $root
try {
    $sha = (git rev-parse HEAD).Trim()
    if ($sha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid commit' }
    if (git status --porcelain --untracked-files=normal) { throw 'Working tree is not clean; deploy a reviewed commit only' }
    # Build inside the clean checked-out commit, never label a stale dist as HEAD.
    foreach ($task in @('prepare:assets', 'build')) {
        if (Test-Path -LiteralPath '.tools/npm/bin/npm-cli.js') { & node .tools/npm/bin/npm-cli.js run $task }
        else { & npm run $task }
        if ($LASTEXITCODE) { throw "Build task failed: $task" }
    }
    if (git status --porcelain --untracked-files=normal) { throw 'Build changed tracked source; refusing deployment' }
    Copy-Item -LiteralPath 'deploy/nginx-location.conf' -Destination 'dist/deploy-location.conf'
    Set-Content -LiteralPath 'dist/version.json' -Value ('{"commit":"' + $sha + '"}') -Encoding utf8
    New-Item -ItemType Directory -Force (Join-Path $root '.tools') | Out-Null
    $archive = Join-Path $root ".tools/qqsg-$sha.tar.gz"
    & tar -czf $archive -C dist .
    if ($LASTEXITCODE) { throw 'Packaging failed' }
    & scp $archive "${HostAlias}:/tmp/qqsg-$sha.tar.gz"
    if ($LASTEXITCODE) { throw 'Upload failed' }
    & scp 'deploy/install.sh' "${HostAlias}:/tmp/qqsg-install.sh"
    if ($LASTEXITCODE) { throw 'Script upload failed' }
    & ssh $HostAlias "sudo bash /tmp/qqsg-install.sh $sha /tmp/qqsg-$sha.tar.gz"
    if ($LASTEXITCODE) { throw 'Remote deploy failed' }
} finally { Pop-Location }
