# Assistente - verificacao de seguranca do Windows (somente leitura, nao altera nada)
# Uso: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/security-check.ps1 [-Full]
#   -Full  tambem procura atualizacoes pendentes do Windows (pode levar 1-2 minutos)
param([switch]$Full)

$ErrorActionPreference = 'SilentlyContinue'
function Write-Section($title) { ""; "## $title" }

"# Relatorio de seguranca - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
"Executado como administrador: $isAdmin"

Write-Section 'Antivirus (Microsoft Defender)'
try {
    $d = Get-MpComputerStatus -ErrorAction Stop
    "Antivirus ativo: $($d.AntivirusEnabled)"
    "Protecao em tempo real: $($d.RealTimeProtectionEnabled)"
    "Assinaturas atualizadas em: $($d.AntivirusSignatureLastUpdated) (idade: $($d.AntivirusSignatureAge) dias)"
    "Ultima verificacao rapida: $($d.QuickScanEndTime)"
    "Ultima verificacao completa: $($d.FullScanEndTime)"
    $threats = Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 5
    if ($threats) {
        "Ameacas detectadas recentemente:"
        foreach ($t in $threats) {
            $name = (Get-MpThreat -ThreatID $t.ThreatID).ThreatName
            "- $($t.InitialDetectionTime): $name (removida com sucesso: $($t.ActionSuccess))"
        }
    } else { "Nenhuma ameaca registrada." }
} catch { "Nao foi possivel ler o Defender: $($_.Exception.Message)" }

Write-Section 'Firewall'
Get-NetFirewallProfile | ForEach-Object {
    $status = if ($_.Enabled) { 'ativado' } else { 'DESATIVADO' }
    "$($_.Name): $status"
}

Write-Section 'Controle de Conta de Usuario (UAC)'
$uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System').EnableLUA
if ($uac -eq 1) { 'UAC ativado' } else { 'UAC DESATIVADO' }

Write-Section 'Atualizacoes do Windows'
$hot = Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 3
if ($hot) { foreach ($h in $hot) { "- $($h.HotFixID) instalada em $($h.InstalledOn.ToString('yyyy-MM-dd'))" } }
else { 'Nao foi possivel listar as atualizacoes instaladas.' }
if ($Full) {
    try {
        $searcher = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
        $pending = $searcher.Search('IsInstalled=0 and IsHidden=0').Updates
        "Atualizacoes pendentes: $($pending.Count)"
        foreach ($u in $pending) { "- $($u.Title)" }
    } catch { "Nao foi possivel consultar atualizacoes pendentes: $($_.Exception.Message)" }
} else { '(use -Full para procurar atualizacoes pendentes)' }

Write-Section 'Programas que iniciam com o Windows'
Get-CimInstance Win32_StartupCommand | ForEach-Object { "- $($_.Name): $($_.Command) [$($_.Location)]" }

Write-Section 'Portas abertas para a rede (escutando fora do localhost)'
$listen = Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }
$listen | Sort-Object LocalPort -Unique | ForEach-Object {
    $proc = (Get-Process -Id $_.OwningProcess).ProcessName
    "- Porta $($_.LocalPort) ($($_.LocalAddress)) - processo: $proc"
}

Write-Section 'Administradores locais'
Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { "- $($_.Name) ($($_.PrincipalSource))" }

Write-Section 'Tentativas de login com falha (ultimas 24h)'
if ($isAdmin) {
    $fails = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625; StartTime = (Get-Date).AddDays(-1) }
    "Total: $(@($fails).Count)"
} else { 'Requer administrador para ler o log de seguranca (pulado).' }
