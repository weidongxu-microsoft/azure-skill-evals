$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$scenariosRoot = Join-Path $root "scenarios"

$goldenRoots = Get-ChildItem $scenariosRoot -Directory |
    ForEach-Object { Join-Path $_.FullName "golden" } |
    Where-Object { Test-Path $_ -PathType Container } |
    Sort-Object

foreach ($goldenRoot in $goldenRoots) {
    $validated = $false

    $pythonFiles = @(Get-ChildItem $goldenRoot -Recurse -File -Filter *.py)
    if ($pythonFiles.Count -gt 0) {
        python -m compileall -q $goldenRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Python golden application compilation failed: $goldenRoot"
        }

        python -m ruff check $goldenRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Python golden application lint failed: $goldenRoot"
        }

        $validated = $true
    }

    foreach ($project in Get-ChildItem $goldenRoot -File -Filter *.csproj) {
        dotnet build $project.FullName --nologo --verbosity quiet
        if ($LASTEXITCODE -ne 0) {
            throw ".NET golden application validation failed: $($project.FullName)"
        }

        $validated = $true
    }

    $pom = Join-Path $goldenRoot "pom.xml"
    if (Test-Path $pom -PathType Leaf) {
        mvn -q -f $pom compile
        if ($LASTEXITCODE -ne 0) {
            throw "Java golden application validation failed: $pom"
        }

        $validated = $true
    }

    $package = Join-Path $goldenRoot "package.json"
    if (Test-Path $package -PathType Leaf) {
        pnpm --dir $goldenRoot install --frozen-lockfile --ignore-scripts `
            --registry=https://pkgs.dev.azure.com/azure-sdk/public/_packaging/azure-sdk-for-js/npm/registry/
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript golden application dependency restore failed: $goldenRoot"
        }

        pnpm --dir $goldenRoot build
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript golden application validation failed: $goldenRoot"
        }

        $validated = $true
    }

    if (-not $validated) {
        throw "No supported golden application found: $goldenRoot"
    }
}
