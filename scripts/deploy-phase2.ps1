param([string]$HostAlias = 'tx', [string]$NamesDirectory)
$ErrorActionPreference = 'Stop'
if ($HostAlias -notmatch '^[a-zA-Z0-9_.-]+$') { throw 'Use a configured SSH host alias' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $projectRoot
try {
    $sha = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -or $sha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid commit' }
    $gitStatus = & git status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -or $gitStatus) { throw 'Deploy a clean reviewed commit only' }
    $localDeploy = Join-Path $projectRoot ".tools/deployment/$sha"
    New-Item -ItemType Directory -Force $localDeploy | Out-Null
    $archive = Join-Path $localDeploy 'package.tar.gz'
    if (-not (Test-Path -LiteralPath $archive)) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-phase2.ps1
        if ($LASTEXITCODE) { throw 'Package build failed' }
        $package = Get-ChildItem .tools/phase2-package -Directory | Sort-Object Name -Descending | Select-Object -First 1
        New-Item -ItemType Directory -Force (Join-Path $package.FullName 'deploy') | Out-Null
        foreach ($name in @('nginx-phase2.conf','qqsg-fighting.service')) { Copy-Item -LiteralPath "deploy/$name" -Destination (Join-Path $package.FullName "deploy/$name") }
        [IO.File]::WriteAllText((Join-Path $package.FullName 'web/version.json'),('{"commit":"'+$sha+'"}'),[Text.UTF8Encoding]::new($false))
        & tar -czf $archive -C $package.FullName web bin deploy
        if ($LASTEXITCODE) { throw 'Archive creation failed' }
    }
    $gitStatus = & git status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -or $gitStatus) { throw 'Build altered tracked files' }
    $builtHead = & git rev-parse HEAD
    if ($LASTEXITCODE -or $builtHead.Trim() -ne $sha) { throw 'HEAD changed during build' }
    $stage = (& ssh -o BatchMode=yes $HostAlias "umask 077; mktemp -d /var/tmp/qqsg-deploy-$sha.XXXXXX").Trim()
    if ($LASTEXITCODE -or $stage -notmatch "^/var/tmp/qqsg-deploy-$sha\.[A-Za-z0-9]+$") { throw 'Could not create private staging directory' }
    & scp $archive "${HostAlias}:$stage/package.tar.gz"
    if ($LASTEXITCODE) { throw 'Package upload failed' }
    & scp deploy/install-phase2.sh "${HostAlias}:$stage/install.sh"
    if ($LASTEXITCODE) { throw 'Installer upload failed' }
    $remoteNames = ''
    if ($NamesDirectory) {
        $namesPath = [IO.Path]::GetFullPath($NamesDirectory)
        foreach ($name in @('name_a.txt','name_b.txt','name_others.txt')) { if (-not (Test-Path -LiteralPath (Join-Path $namesPath $name))) { throw "Missing $name" } }
        $namesArchive = Join-Path $localDeploy 'names.tar.gz'
        $nameFiles = @('name_a.txt','name_b.txt','name_others.txt','aliases.tsv','blacklist.txt') | Where-Object { Test-Path -LiteralPath (Join-Path $namesPath $_) }
        & tar -czf $namesArchive -C $namesPath @nameFiles
        if ($LASTEXITCODE) { throw 'Name package creation failed' }
        & scp $namesArchive "${HostAlias}:$stage/names.tar.gz"
        if ($LASTEXITCODE) { throw 'Name upload failed' }
        $remoteNames = "$stage/names.tar.gz"
    }
    $credentialFile = Join-Path $projectRoot '.tools/deployment/admin-credentials.txt'
    if (-not (Test-Path -LiteralPath $credentialFile)) {
        $bytes = New-Object byte[] 24
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $password = ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
        [IO.File]::WriteAllLines($credentialFile,@('https://jinbaofu.cn/fighting/admin/','admin',$password),[Text.UTF8Encoding]::new($false))
    }
    $password = [IO.File]::ReadAllLines($credentialFile)[2]
    & ssh -o BatchMode=yes $HostAlias "bash -n $stage/install.sh"
    if ($LASTEXITCODE) { throw 'Installer syntax check failed' }
    $password | & ssh -o BatchMode=yes $HostAlias "sudo -n bash $stage/install.sh $sha $stage/package.tar.gz $remoteNames"
    if ($LASTEXITCODE) { throw 'Deployment failed; inspect recorded rollback output' }
    [IO.File]::WriteAllText((Join-Path $localDeploy 'deployment.json'),(@{commit=$sha;host=$HostAlias;remoteStage=$stage;deployedAtUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    Write-Output "Deployment complete. Local credential file: $credentialFile"
} finally { Pop-Location }
