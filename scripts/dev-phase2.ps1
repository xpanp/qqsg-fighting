param([switch]$InitAdmin, [string]$NamesDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$goTool = Join-Path $projectRoot '.tools/go/bin/go.exe'
if (-not (Test-Path -LiteralPath $goTool)) { $goTool = (Get-Command go -ErrorAction Stop).Source }
$runtimeDirectory = Join-Path $projectRoot '.tools/local-server'
$resolvedNamesDirectory = if ($NamesDirectory) { [IO.Path]::GetFullPath($NamesDirectory) } else { $null }
$binary = Join-Path $projectRoot '.tools/qqsg-server-local.exe'
New-Item -ItemType Directory -Force $runtimeDirectory | Out-Null
$savedEnvironment = @{}
foreach ($key in @('GOCACHE','GOMODCACHE','GOPATH','GOPROXY','QQSG_ADMIN_PASSWORD')) { $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
Push-Location (Join-Path $projectRoot 'backend')
try {
    $env:GOCACHE = Join-Path $projectRoot '.tools/go-cache'
    $env:GOMODCACHE = Join-Path $projectRoot '.tools/go-modcache'
    $env:GOPATH = Join-Path $projectRoot '.tools/gopath'
    $env:GOPROXY = 'https://goproxy.cn,direct'
    & $goTool build -o $binary ./cmd/server
    if ($LASTEXITCODE) { throw 'Backend build failed' }
    $serverArguments = @('--data-dir',$runtimeDirectory,'--listen','127.0.0.1:8780','--origin','http://127.0.0.1:5173','--insecure-local')
    if ($InitAdmin) {
        $adminSecret = Read-Host '设置本地 admin 密码（12—72 字节，不会显示）' -AsSecureString
        try {
            $env:QQSG_ADMIN_PASSWORD = [Net.NetworkCredential]::new('', $adminSecret).Password
            & $binary @serverArguments --init-admin
            if ($LASTEXITCODE) { throw 'Admin initialization failed' }
        } finally { $env:QQSG_ADMIN_PASSWORD = $null; $adminSecret.Dispose() }
    }
    if ($NamesDirectory) {
        & $binary @serverArguments --import-names $resolvedNamesDirectory
        if ($LASTEXITCODE) { throw 'Name import failed' }
    }
    Write-Host 'Go API: http://127.0.0.1:8780 ; 另开终端 npm run dev，访问 http://127.0.0.1:5173/fighting/admin/'
    & $binary @serverArguments
    if ($LASTEXITCODE) { throw 'Backend exited with an error' }
} finally {
    Pop-Location
    foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key,$savedEnvironment[$key],'Process') }
}
