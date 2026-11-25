param([string]$OutputDirectory = '.tools/phase2-package')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $projectRoot
try {
    $goTool = Join-Path $projectRoot '.tools/go/bin/go.exe'
    if (-not (Test-Path -LiteralPath $goTool)) { $goTool = (Get-Command go -ErrorAction Stop).Source }
    foreach ($task in @('prepare:assets','build')) {
        if (Test-Path -LiteralPath '.tools/npm/bin/npm-cli.js') { & node .tools/npm/bin/npm-cli.js run $task } else { & npm run $task }
        if ($LASTEXITCODE) { throw "Frontend task failed: $task" }
    }
    $destination = [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
    if (-not $destination.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be inside project' }
    # Unique package directory; never recursively delete a caller-supplied path.
    $package = Join-Path $destination (Get-Date -Format 'yyyyMMdd-HHmmss')
    New-Item -ItemType Directory -Force (Join-Path $package 'web'),(Join-Path $package 'bin') | Out-Null
    Copy-Item -Path dist/* -Destination (Join-Path $package 'web') -Recurse
    $previousGoEnvironment = @{}
    foreach ($key in @('GOOS','GOARCH','CGO_ENABLED','GOCACHE','GOMODCACHE','GOPATH','GOPROXY')) { $previousGoEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
    try {
        $env:GOOS = 'linux'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
        $env:GOCACHE = Join-Path $projectRoot '.tools/go-cache'
        $env:GOMODCACHE = Join-Path $projectRoot '.tools/go-modcache'
        $env:GOPATH = Join-Path $projectRoot '.tools/gopath'
        $env:GOPROXY = 'https://goproxy.cn,direct'
        Push-Location backend
        try { & $goTool build -trimpath -o (Join-Path $package 'bin/qqsg-server') ./cmd/server; if ($LASTEXITCODE) { throw 'Go build failed' } }
        finally { Pop-Location }
    } finally { foreach ($key in $previousGoEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $previousGoEnvironment[$key], 'Process') } }
    Write-Output $package
} finally { Pop-Location }
