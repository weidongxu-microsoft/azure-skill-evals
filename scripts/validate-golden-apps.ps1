$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$scenariosRoot = Join-Path $root "scenarios"

Get-ChildItem $scenariosRoot -Recurse -Filter *.csproj |
    Where-Object { $_.Directory.Name -eq "golden" } |
    ForEach-Object {
        dotnet build $_.FullName --nologo --verbosity quiet
        if ($LASTEXITCODE -ne 0) {
            throw ".NET golden application validation failed: $($_.FullName)"
        }
    }

Get-ChildItem $scenariosRoot -Recurse -Filter pom.xml |
    Where-Object { $_.Directory.Name -eq "golden" } |
    ForEach-Object {
        mvn -q -f $_.FullName compile
        if ($LASTEXITCODE -ne 0) {
            throw "Java golden application validation failed: $($_.FullName)"
        }
    }

Get-ChildItem $scenariosRoot -Recurse -Filter package.json |
    Where-Object { $_.Directory.Name -eq "golden" } |
    ForEach-Object {
        $typescriptRoot = $_.Directory.FullName
        pnpm --dir $typescriptRoot install --frozen-lockfile --ignore-scripts
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript golden application dependency restore failed: $typescriptRoot"
        }

        pnpm --dir $typescriptRoot build
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript golden application validation failed: $typescriptRoot"
        }
    }
