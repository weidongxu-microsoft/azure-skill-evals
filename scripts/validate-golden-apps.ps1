$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$scenariosRoot = Join-Path $root "scenarios"
$npmRegistry = if ($env:GITHUB_ACTIONS -eq "true") {
    "https://registry.npmjs.org/"
} else {
    "https://pkgs.dev.azure.com/azure-sdk/public/_packaging/azure-sdk-for-js/npm/registry/"
}

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
            throw "Python reference application compilation failed: $goldenRoot"
        }

        python -m ruff check $goldenRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Python reference application lint failed: $goldenRoot"
        }

        $validated = $true
    }

    foreach ($project in Get-ChildItem $goldenRoot -Recurse -File -Filter *.csproj) {
        dotnet build $project.FullName --nologo --verbosity quiet
        if ($LASTEXITCODE -ne 0) {
            throw ".NET reference application validation failed: $($project.FullName)"
        }

        $validated = $true
    }

    $pom = Join-Path $goldenRoot "pom.xml"
    if (Test-Path $pom -PathType Leaf) {
        mvn -q -f $pom compile
        if ($LASTEXITCODE -ne 0) {
            throw "Java reference application validation failed: $pom"
        }

        $validated = $true
    }

    $package = Join-Path $goldenRoot "package.json"
    if (Test-Path $package -PathType Leaf) {
        pnpm --dir $goldenRoot install --frozen-lockfile --ignore-scripts `
            --registry=$npmRegistry
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript reference application dependency restore failed: $goldenRoot"
        }

        pnpm --dir $goldenRoot build
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript reference application validation failed: $goldenRoot"
        }

        $validated = $true
    }

    $goModule = Join-Path $goldenRoot "go.mod"
    if (Test-Path $goModule -PathType Leaf) {
        Push-Location $goldenRoot
        try {
            go test -mod=readonly ./...
            if ($LASTEXITCODE -ne 0) {
                throw "Go reference application tests failed: $goldenRoot"
            }

            go vet ./...
            if ($LASTEXITCODE -ne 0) {
                throw "Go reference application vet failed: $goldenRoot"
            }
        }
        finally {
            Pop-Location
        }

        $validated = $true
    }

    if (-not $validated) {
        throw "No supported reference application found: $goldenRoot"
    }
}
