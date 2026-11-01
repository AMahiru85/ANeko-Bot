param(
  [switch]$Remote
)

$ErrorActionPreference = "Stop"

$repoUrl = if ($env:REPO_URL) { $env:REPO_URL } else { "https://github.com/AMahiru85/ANeko-Bot.git" }
$installDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path (Get-Location) "aneko-bot" }
if ($Remote -or -not (Test-Path .env.example)) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required for remote installation. Install it from https://git-scm.com/ and run this script again."
  }
  if (Test-Path $installDir) {
    if (-not (Test-Path (Join-Path $installDir ".git"))) { throw "$installDir exists and is not a Git repository." }
    git -C $installDir pull --ff-only
  } else {
    git clone --depth 1 $repoUrl $installDir
  }
  Set-Location $installDir
}

Write-Host "ANeko-Bot installer" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22.4+ is required. Install it from https://nodejs.org/ and run this script again."
}
$major = [int](node -p "process.versions.node.split('.')[0]")
$minor = [int](node -p "process.versions.node.split('.')[1]")
if (($major -lt 22) -or (($major -eq 22) -and ($minor -lt 4))) {
  throw "Node.js 22.4+ is required. Detected $((node -p 'process.versions.node'))."
}
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Created .env. Fill QQ_APP_ID, QQ_APP_SECRET and a provider key." -ForegroundColor Yellow }
node --check src/config.mjs
node --check src/llm.mjs
node --check src/memory.mjs
node --check src/qq-api.mjs
node --check src/qq-gateway.mjs
node --check src/index.mjs
Write-Host "Ready. Start with: npm start" -ForegroundColor Green
