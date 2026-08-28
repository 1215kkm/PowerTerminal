# PowerTerminal — 굳은 서버 스스로 진찰·회복 (Windows 전용)
#
# freeze.log 에 남은 실제 기록: 서버가 아무 일도 안 하던("idle") 상태에서 심장박동이 멎고
# 15분·27분씩 돌아오지 않았다. 요청 처리 중도, 동기 저장 중도 아니었다 —
# 즉 자바스크립트가 오래 걸린 게 아니라 스레드 자체가 멈춰 세워진 모양새다.
# (같은 PC에서 자식 프로세스가 Suspended 로 태어나 안 깨어나는 일도 이미 겪었다.)
#
# 그래서 굳은 순간 감시 스레드가 이 스크립트를 부른다. 하는 일:
#   ① 그 프로세스의 스레드 상태를 그대로 찍어 남기고 (다음 분석의 증거)
#   ② Suspended 로 세워진 스레드가 있으면 깨운다 — 그러면 서버가 스스로 돌아온다
#
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File unfreeze.ps1 -TargetPid 1234

param([Parameter(Mandatory = $true)][int]$TargetPid)

# 출력은 UTF-8 로 — 부모(Node)가 UTF-8 로 읽기 때문에, 기본 코드페이지(949)로 내보내면 기록이 깨진다
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$ErrorActionPreference = 'SilentlyContinue'


# 스레드가 멀쩡한데 멈췄다면 남는 용의자는 디스크다 — 굳은 순간의 디스크 상태와
# 그때 돌고 있던 자식 프로세스(git·gh 등)를 같이 남긴다. (2026-08-29 03:04 사례:
# 세워진 스레드가 하나도 없이 171초 멈춤 · 그때 탐색기가 파일 25만 개를 C:→D: 로 옮기는 중이었다)
function Show-DiskLoad {
  try {
    $c = Get-Counter '\PhysicalDisk(*)\% Disk Time','\PhysicalDisk(*)\Avg. Disk Queue Length' -SampleInterval 1 -MaxSamples 2 -ErrorAction Stop
    $c.CounterSamples | Where-Object { $_.InstanceName -ne '_total' } | Group-Object InstanceName | ForEach-Object {
      $dt = ($_.Group | Where-Object Path -like '*disk time*' | Measure-Object CookedValue -Average).Average
      $q  = ($_.Group | Where-Object Path -like '*queue*' | Measure-Object CookedValue -Average).Average
      "     디스크 {0,-10} 사용률 {1,5:N0}% · 대기열 {2,5:N2}" -f $_.Name, $dt, $q
    }
  } catch { "     (디스크 상태 조회 실패)" }
}
function Show-Children {
  try {
    $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$TargetPid"
    if (-not $kids) { "     자식 프로세스: 없음"; return }
    foreach ($k in $kids) {
      $kp = Get-Process -Id $k.ProcessId -ErrorAction SilentlyContinue
      $age = if ($kp) { [math]::Round(((Get-Date) - $kp.StartTime).TotalSeconds) } else { 0 }
      "     자식: {0} (PID {1}) {2}초째" -f $k.Name, $k.ProcessId, $age
    }
  } catch {}
}
$p = Get-Process -Id $TargetPid
if (-not $p) { "     (진찰: PID $TargetPid 프로세스가 없음)"; exit 0 }

"     ── 스레드 상태 ──"
Show-DiskLoad
Show-Children
$susp = @()
foreach ($t in $p.Threads) {
  $line = "       스레드 {0,-6} {1,-10} {2,-14} CPU {3,7:N2}s" -f $t.Id, $t.ThreadState, $t.WaitReason, $t.TotalProcessorTime.TotalSeconds
  $line
  if ($t.WaitReason -eq 'Suspended') { $susp += $t.Id }
}
"       메모리 {0:N0}MB · 핸들 {1} · 총 CPU {2:N1}s" -f ($p.WorkingSet64 / 1MB), $p.HandleCount, $p.TotalProcessorTime.TotalSeconds

if ($susp.Count -eq 0) {
  "     ── 멈춰 세워진 스레드는 없음 (동기 호출에 붙잡힌 쪽을 의심) ──"
  exit 0
}

Add-Type -ErrorAction SilentlyContinue -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PtFreeze {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern int ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@

foreach ($tid in $susp) {
  $h = [PtFreeze]::OpenThread(0x0002, $false, [uint32]$tid)     # THREAD_SUSPEND_RESUME
  if ($h -eq [IntPtr]::Zero) { "     ⚠ 스레드 $tid 를 열지 못함"; continue }
  $prev = [PtFreeze]::ResumeThread($h)
  [PtFreeze]::CloseHandle($h) | Out-Null
  if ($prev -ge 0) { "     ✔ 멈춰 있던 스레드 $tid 를 깨움 (정지 횟수 $prev)" }
  else { "     ⚠ 스레드 $tid 깨우기 실패" }
}
