param([string]$Version = '1.27.4')
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use an explicit Go version, e.g. 1.27.4' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $projectRoot '.tools'
$downloads = Join-Path $tools 'go-download'
New-Item -ItemType Directory -Force $downloads | Out-Null
if (Test-Path -LiteralPath (Join-Path $tools 'go')) { throw 'Existing .tools/go retained. Review/move it before installing another version.' }
$manifest = Invoke-RestMethod 'https://golang.google.cn/dl/?mode=json&include=all' -TimeoutSec 60
$release = $manifest | Where-Object { $_.version -eq ('go' + $Version) } | Select-Object -First 1
$file = $release.files | Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'amd64' -and $_.kind -eq 'archive' } | Select-Object -First 1
if (-not $file -or $file.filename -ne "go$Version.windows-amd64.zip" -or $file.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Go archive metadata not found/invalid' }
$archive = Join-Path $downloads $file.filename
Invoke-WebRequest ('https://golang.google.cn/dl/' + $file.filename) -OutFile $archive -TimeoutSec 300
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'Go SHA256 mismatch' }
Expand-Archive -LiteralPath $archive -DestinationPath $tools
& (Join-Path $tools 'go/bin/go.exe') version
