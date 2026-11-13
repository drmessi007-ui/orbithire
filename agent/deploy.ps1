[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$')]
  [string]$Server,

  [ValidatePattern('^/[A-Za-z0-9._/-]+$')]
  [string]$RemotePath = "/opt/orbithire-agent",

  [string]$Platform = "linux/amd64",

  [switch]$EnableHttps
)

$ErrorActionPreference = "Stop"
$imageName = "orbithire-agent:latest"
$imageArchive = Join-Path ([System.IO.Path]::GetTempPath()) "orbithire-agent-$PID.tar"

foreach ($commandName in @("docker", "ssh", "scp")) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "Required command '$commandName' was not found."
  }
}

$remoteDirectory = "${Server}:$RemotePath"
$remoteArchivePath = "$RemotePath/orbithire-agent.tar"
$remoteArchive = "${Server}:$remoteArchivePath"
$preflightCommand = "mkdir -p $RemotePath && test -f $RemotePath/.env"
$deployCommand = "cd $RemotePath && docker load -i orbithire-agent.tar && "
if ($EnableHttps) {
  $deployCommand += "docker compose --profile https up -d --no-build"
} else {
  $deployCommand += "docker compose up -d --no-build"
}
$deployCommand += " && rm -f -- orbithire-agent.tar"

try {
  Write-Host "Checking the remote directory and protected .env file..."
  & ssh $Server $preflightCommand
  if ($LASTEXITCODE -ne 0) {
    throw "Remote preflight failed. Create $RemotePath/.env from .env.example on the server first."
  }

  Write-Host "Building $imageName for $Platform..."
  & docker build --platform $Platform --tag $imageName --file (Join-Path $PSScriptRoot "Dockerfile") $PSScriptRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Docker image build failed."
  }

  Write-Host "Saving the image archive..."
  & docker save --output $imageArchive $imageName
  if ($LASTEXITCODE -ne 0) {
    throw "Docker image export failed."
  }

  Write-Host "Uploading the image and deployment configuration (not .env)..."
  & scp $imageArchive $remoteArchive
  if ($LASTEXITCODE -ne 0) {
    throw "Uploading the image archive failed."
  }

  $deploymentFiles = @(
    (Join-Path $PSScriptRoot "Dockerfile"),
    (Join-Path $PSScriptRoot "docker-compose.yml"),
    (Join-Path $PSScriptRoot "Caddyfile"),
    (Join-Path $PSScriptRoot ".env.example")
  )
  & scp @deploymentFiles "$remoteDirectory/"
  if ($LASTEXITCODE -ne 0) {
    throw "Uploading deployment configuration failed."
  }

  Write-Host "Loading the image and restarting the remote service..."
  & ssh $Server $deployCommand
  if ($LASTEXITCODE -ne 0) {
    throw "Remote deployment failed."
  }

  Write-Host "Deployment finished. Check service health with:"
  Write-Host "  ssh $Server 'curl -fsS http://127.0.0.1:8787/health'"
  if ($EnableHttps) {
    Write-Host "Public health URL: https://<DOMAIN>/health"
  }
} finally {
  if (Test-Path -LiteralPath $imageArchive) {
    Remove-Item -LiteralPath $imageArchive -Force
  }
}
