param([string]$HistoryDirectory, [switch]$BrowserSmoke)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$goTool = Join-Path $projectRoot '.tools/go/bin/go.exe'
if (-not (Test-Path -LiteralPath $goTool)) { $goTool = (Get-Command go -ErrorAction Stop).Source }
$savedEnvironment = @{}
foreach ($key in @('GOCACHE','GOMODCACHE','GOPATH','GOPROXY','QQSG_TEST_SERVER','QQSG_TEST_ADMIN_PASSWORD')) { $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
Push-Location $projectRoot
try {
    $env:GOCACHE = Join-Path $projectRoot '.tools/go-cache'
    $env:GOMODCACHE = Join-Path $projectRoot '.tools/go-modcache'
    $env:GOPATH = Join-Path $projectRoot '.tools/gopath'
    $env:GOPROXY = 'https://goproxy.cn,direct'
    $env:QQSG_TEST_SERVER = $null
    $env:QQSG_TEST_ADMIN_PASSWORD = $null
    foreach ($task in @('test','typecheck','build')) {
        if (Test-Path -LiteralPath '.tools/npm/bin/npm-cli.js') { & node .tools/npm/bin/npm-cli.js run $task } else { & npm run $task }
        if ($LASTEXITCODE) { throw "Frontend verification failed: $task" }
    }
    Push-Location backend
    try {
        & $goTool test -count=1 ./...
        if ($LASTEXITCODE) { throw 'Go tests failed' }
        & $goTool vet ./...
        if ($LASTEXITCODE) { throw 'Go vet failed' }
        & $goTool build -o (Join-Path $projectRoot '.tools/qqsg-server-test.exe') ./cmd/server
        if ($LASTEXITCODE) { throw 'Backend build failed' }
    } finally { Pop-Location }
    $harnessArguments = @('tests/phase2/run-http.mjs','--binary','.tools/qqsg-server-test.exe')
    if ($HistoryDirectory) { $harnessArguments += @('--history-root',[IO.Path]::GetFullPath($HistoryDirectory)) }
    & node @harnessArguments
    if ($LASTEXITCODE) { throw 'Local HTTP/history validation failed' }
    if ($BrowserSmoke) {
        & node tests/phase2/browser-smoke.mjs --binary .tools/qqsg-server-test.exe
        if ($LASTEXITCODE) { throw 'Browser smoke failed; see browser/environment limitations before calling it passed' }
    }
    Write-Output 'Local verification passed. No remote deployment or Git push was performed.'
} finally {
    Pop-Location
    foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key,$savedEnvironment[$key],'Process') }
}
