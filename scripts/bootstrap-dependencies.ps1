#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

$lockPath = Join-Path $RepositoryRoot "dependencies.lock.json"
$dependencyRoot = Join-Path $RepositoryRoot ".work" "dependencies"
$lock = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $dependencyRoot | Out-Null

foreach ($repository in $lock.repositories) {
    $target = Join-Path $dependencyRoot $repository.name

    if (-not (Test-Path -LiteralPath $target)) {
        New-Item -ItemType Directory -Path $target | Out-Null
        git -C $target init --quiet
        git -C $target remote add origin $repository.url
    }

    if (-not (Test-Path -LiteralPath (Join-Path $target ".git"))) {
        throw "Dependency path is not a Git repository: $target"
    }

    $changes = git -C $target status --porcelain
    if ($changes) {
        throw "Dependency repository has local changes: $target"
    }

    git -C $target fetch --quiet --depth 1 origin $repository.commit
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to fetch $($repository.name) at $($repository.commit)"
    }

    git -C $target checkout --quiet --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to check out $($repository.name) at $($repository.commit)"
    }

    $actualCommit = git -C $target rev-parse HEAD
    if ($actualCommit -ne $repository.commit) {
        throw "Expected $($repository.commit) for $($repository.name), got $actualCommit"
    }

    Write-Information "$($repository.name): $actualCommit"
}

