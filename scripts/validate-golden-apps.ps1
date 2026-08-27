$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

dotnet build `
    (Join-Path $root "scenarios/cosmos-db-dotnet-crud/golden/CosmosCrud.csproj") `
    --nologo `
    --verbosity quiet
if ($LASTEXITCODE -ne 0) {
    throw ".NET golden application validation failed."
}

mvn -q `
    -f (Join-Path $root "scenarios/cosmos-db-java-crud/golden/pom.xml") `
    compile
if ($LASTEXITCODE -ne 0) {
    throw "Java golden application validation failed."
}

$typescriptRoot = Join-Path $root "scenarios/cosmos-db-typescript-crud/golden"
pnpm --dir $typescriptRoot install --frozen-lockfile --ignore-scripts
if ($LASTEXITCODE -ne 0) {
    throw "TypeScript golden application dependency restore failed."
}

pnpm --dir $typescriptRoot build
if ($LASTEXITCODE -ne 0) {
    throw "TypeScript golden application validation failed."
}
