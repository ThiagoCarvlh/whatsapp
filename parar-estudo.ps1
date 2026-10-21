$ErrorActionPreference = 'Stop'
$studyState = Invoke-RestMethod -Uri 'http://127.0.0.1:2887/state' -TimeoutSec 5
$studyHeaders = @{ Origin = 'http://127.0.0.1:2887'; 'X-Study-CSRF' = $studyState.csrf }
$null = Invoke-RestMethod -Uri 'http://127.0.0.1:2887/shutdown' -Method Post `
    -Headers $studyHeaders -ContentType 'application/json' -Body '{}' -TimeoutSec 5
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (-not (Get-NetTCPConnection -LocalPort 2785 -State Listen -ErrorAction SilentlyContinue)) {
        Write-Output 'OpenWA encerrado com fechamento da sessão local.'
        return
    }
    Start-Sleep -Seconds 1
}
throw 'O encerramento ainda está em andamento. Não inicie outra instância.'
