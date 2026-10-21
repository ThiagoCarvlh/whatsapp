$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$activeListener = Get-NetTCPConnection -LocalPort 2785 -State Listen -ErrorAction SilentlyContinue
if ($activeListener) {
    Write-Output 'OpenWA já está ouvindo na porta 2785.'
    return
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist/main.js'))) {
    throw 'Compile o projeto com npm run build antes de iniciar.'
}
$env:NODE_ENV = 'development'
$env:BIND_HOST = '127.0.0.1'
$env:PORT = '2785'
$env:TZ = 'America/Manaus'
$env:LOG_LEVEL = 'warn'
$env:ENGINE_TYPE = 'whatsapp-web.js'
$env:WWEBJS_WEB_VERSION = 'off'
$env:DATABASE_TYPE = 'sqlite'
$env:DATABASE_SYNCHRONIZE = 'true'
$env:CACHE_ENABLED = 'false'
$env:REDIS_ENABLED = 'false'
$env:QUEUE_ENABLED = 'false'
$env:POSTGRES_BUILTIN = 'false'
$env:REDIS_BUILTIN = 'false'
$env:MINIO_BUILTIN = 'false'
$env:MCP_ENABLED = 'false'
$env:STUDY_UI_ENABLED = 'true'
$env:AUTO_START_SESSIONS = 'true'
$env:SEND_PACING_ENABLED = 'true'
$env:WWEBJS_AUTH_TIMEOUT_MS = '120000'
$env:WWEBJS_ONBOARDING_CONTINUE_LABELS = 'Continuar'
$env:PUPPETEER_PROTOCOL_TIMEOUT_MS = '180000'
$chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (Test-Path -LiteralPath $chromePath) {
    $env:PUPPETEER_EXECUTABLE_PATH = $chromePath
}
$dataPath = Join-Path $projectRoot 'data'
[System.IO.Directory]::CreateDirectory($dataPath) | Out-Null
$runStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$serverProcess = Start-Process -FilePath $nodeExe -ArgumentList 'dist/main.js' `
    -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dataPath "server-$runStamp.out.log") `
    -RedirectStandardError (Join-Path $dataPath "server-$runStamp.err.log") -PassThru
Write-Output "OpenWA iniciado em http://127.0.0.1:2785 (PID $($serverProcess.Id))."
