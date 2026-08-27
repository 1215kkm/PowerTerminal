# PowerTerminal — 멈춘 하위 프로세스 깨우기 (Windows 전용)
#
# 실제로 겪은 사고: 세션이 띄운 bash.exe 가 CPU 0.000초 · 스레드 1개 · Suspended 상태로 태어나
# 아무도 깨우지 않아 영원히 잠들었다. 그 명령을 기다리던 Claude 는 끝나지 않고, 새 요청은 큐에만
# 쌓여 "세션이 멈췄다" 로 보였다. (윈도우에서 자식 프로세스는 CREATE_SUSPENDED 로 만들어진 뒤
# job object 에 등록하고 ResumeThread 로 깨우는데, 그 중간이 어긋나면 이렇게 된다.)
#
# 여기서는 PT 서버의 자손 프로세스만 훑어 그 상태인 것을 찾아 ResumeThread 로 깨운다.
# 깨우지 못하면 종료시킨다 — 어느 쪽이든 기다리던 명령은 결과를 받고 세션이 다시 흐른다.
#
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File unstick.ps1 -ServerPid 1234 [-MinAgeSec 20]
# 출력: 한 줄에 하나,  RESUMED|KILLED <pid> <이름> <최상위조상pid> <나이초>

param(
  [Parameter(Mandatory = $true)][int]$ServerPid,
  [int]$MinAgeSec = 20
)

$ErrorActionPreference = 'SilentlyContinue'

# 부모 → 자식 지도 한 번만 만든다 (프로세스가 수백 개라도 WMI 호출은 1회)
$procs = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate
if (-not $procs) { exit 0 }
$byParent = @{}
foreach ($p in $procs) {
  if (-not $byParent.ContainsKey([int]$p.ParentProcessId)) { $byParent[[int]$p.ParentProcessId] = @() }
  $byParent[[int]$p.ParentProcessId] += $p
}

# PT 서버의 자손 전부 — 각각 '어느 세션 갈래에서 나왔는지'(서버의 직계 자식) 를 함께 들고 다닌다
$targets = @()
$stack = @()
foreach ($c in $byParent[$ServerPid]) { $stack += [pscustomobject]@{ Proc = $c; Top = [int]$c.ProcessId } }
while ($stack.Count -gt 0) {
  $cur = $stack[0]; $stack = $stack[1..($stack.Count)]
  if ($null -eq $cur) { continue }
  $targets += $cur
  foreach ($c in $byParent[[int]$cur.Proc.ProcessId]) {
    $stack += [pscustomobject]@{ Proc = $c; Top = $cur.Top }
  }
}
if ($targets.Count -eq 0) { exit 0 }

Add-Type -ErrorAction SilentlyContinue -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PtThread {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern int ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@

$now = Get-Date
foreach ($t in $targets) {
  $pid2 = [int]$t.Proc.ProcessId
  $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  if (-not $proc) { continue }

  # 걸린 놈의 서명: 스레드 1개 · 그 스레드가 Suspended · CPU 를 단 한 순간도 쓰지 않음.
  # 셋이 동시에 맞는 정상 프로세스는 없다 — 일하다 잠깐 멈춘 것과 태어나자마자 잠든 것을 이렇게 가른다.
  if ($proc.Threads.Count -ne 1) { continue }
  if ($proc.Threads[0].WaitReason -ne 'Suspended') { continue }
  if ($proc.TotalProcessorTime.TotalSeconds -gt 0.05) { continue }

  $age = ($now - $proc.StartTime).TotalSeconds
  if ($age -lt $MinAgeSec) { continue }         # 막 태어난 건 건드리지 않는다 (정상적인 한순간일 수 있음)

  $tid = [uint32]$proc.Threads[0].Id
  $h = [PtThread]::OpenThread(0x0002, $false, $tid)     # THREAD_SUSPEND_RESUME
  $ok = $false
  if ($h -ne [IntPtr]::Zero) {
    $prev = [PtThread]::ResumeThread($h)
    [PtThread]::CloseHandle($h) | Out-Null
    if ($prev -ge 0) { $ok = $true }
  }
  if ($ok) {
    "RESUMED {0} {1} {2} {3:N0}" -f $pid2, $proc.ProcessName, $t.Top, $age
  } else {
    # 깨우지 못하면 차라리 끝낸다 — 기다리던 쪽은 '실패' 라도 받아야 다음으로 넘어간다
    Stop-Process -Id $pid2 -Force -ErrorAction SilentlyContinue
    "KILLED {0} {1} {2} {3:N0}" -f $pid2, $proc.ProcessName, $t.Top, $age
  }
}
