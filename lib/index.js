/**
 * dsh-restart-button — host half.
 *
 * Registers POST /restart-button/restart for the title-bar button. The actual
 * restart is performed by a PowerShell helper created through WMI, because only the
 * Desktop shell can close and relaunch itself: the Web/Document layer has no
 * such IPC, and a host self-respawn would fight the Desktop supervisor
 * (dsh-market refuses that exact move under a desktop-managed profile).
 *
 * Helper sequence: let the HTTP response leave -> close the app's main window
 * (WM_CLOSE -> window-all-closed -> app.quit -> graceful host shutdown) -> if
 * the app is still alive after the grace period, kill its process tree ->
 * start the same executable again.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export const name = 'restart-button'
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
const ROOT = '/restart-button'
/** Bumped when the host half changes, so /status reveals which build is loaded. */
const VERSION = 'wmi-2'
/** Windows caption buttons occupy 3 x 46 CSS px at the top right. */
const GRACE_SECONDS = 12
/** Time given to the helper to write its first log line after the WMI create. */
const HELPER_BOOT_TIMEOUT_MS = 3000
/** Upper bound for the synchronous launcher (CIM + wmic fallback). */
const LAUNCHER_TIMEOUT_MS = 20000

/** Loopback-only fence: the desktop document proxy arrives as a loopback peer. */
function isLoopback(req) {
  const address = req.socket === null || req.socket === undefined ? undefined : req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function reply(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

/** The Desktop executable, or null when this host does not belong to the app. */
function desktopExecutable() {
  if (process.versions.electron === undefined) return null
  return typeof process.execPath === 'string' && process.execPath !== '' ? process.execPath : null
}

/** PowerShell single-quote escaping (only embedded quotes need doubling). */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** Synchronous sleep: the helper boot check happens before the response is sent. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The helper script. Kept in one place so the sequencing is auditable. */
export function helperScript(exe, appPid, logPath) {
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$log = ' + psQuote(logPath),
    "function Note([string]$text) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' ' + $text) }",
    "Note ('helper started pid=' + $PID + ' session=' + (Get-Process -Id $PID).SessionId)",
    'Start-Sleep -Milliseconds 1500',
    '$exe = ' + psQuote(exe),
    '$appPid = ' + String(appPid),
    'Note ("target app pid " + $appPid + " exe " + $exe)',
    '    # The host runs as Electron Node mode; a relaunched app must not inherit that switch.',
    'Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
    'Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue',
    '$main = Get-Process -Id $appPid -ErrorAction SilentlyContinue',
    'if ($null -eq $main) {',
    "  Note 'app process not found; starting a new one anyway'",
    '} else {',
    "  Note 'asking the main window to close (WM_CLOSE)'",
    '  $closed = $main.CloseMainWindow()',
    '  if (-not $closed) {',
    "    Note 'no main window handle; asking the process tree to close'",
    '    & taskkill.exe /PID $appPid | Out-Null',
    '  }',
    '  $deadline = (Get-Date).AddSeconds(' + String(GRACE_SECONDS) + ')',
    '  while ((Get-Date) -lt $deadline) {',
    '    $main.Refresh()',
    '    if ($main.HasExited) { break }',
    '    Start-Sleep -Milliseconds 250',
    '  }',
    '  $main.Refresh()',
    '  if (-not $main.HasExited) {',
    "    Note 'graceful close timed out; killing the app process tree'",
    '    & taskkill.exe /F /T /PID $appPid | Out-Null',
    '    Start-Sleep -Milliseconds 1500',
    '  } else {',
    "    Note 'app exited gracefully'",
    '  }',
    '}',
    'Start-Sleep -Milliseconds 1500',
    'Note ("starting " + $exe)',
    '    # Created through WMI on purpose: WmiPrvSE becomes the parent, so the new app gets no',
    '    # console handle from this helper. A child started with Start-Process would inherit',
    '    # this console and die with CTRL_CLOSE_EVENT as soon as the helper window closes.',
    '    $cwd = [System.IO.Path]::GetDirectoryName($exe)',
    '    $commandLine = [char]34 + $exe + [char]34',
    '    $created = $null',
    '    try { $created = ([wmiclass]\'Win32_Process\').Create($commandLine, $cwd, $null) } catch { Note (\'wmi start failed: \' + $_.Exception.Message) }',
    '    if ($null -ne $created -and $created.ReturnValue -eq 0) {',
    '      Note (\'started new pid \' + $created.ProcessId + \' (wmi)\')',
    '    } elseif ($null -ne $created) {',
    '      Note (\'wmi start returned \' + $created.ReturnValue)',
    '    }',
    '    if ($null -eq $created -or $created.ReturnValue -ne 0) {',
    '      $started = Start-Process -FilePath $exe -WorkingDirectory $cwd -PassThru',
    '      if ($null -eq $started) { Note \'start failed\' } else { Note (\'started new pid \' + $started.Id + \' (start-process)\') }',
    '    }',
    'Start-Sleep -Seconds 5',
    "Note 'helper finished'",
  ]
  return lines.join('\r\n') + '\r\n'
}
/**
 * The launcher: creates the helper through WMI so that it outlives this host.
 * WmiPrvSE owns the new process, so the helper keeps running (in the same
 * interactive session) after this process exits. The launcher reports its
 * outcome as JSON, both on stdout and in resultPath.
 *
 * The helper target is a console program, so Win32_ProcessStartup.ShowWindow = 0
 * (SW_HIDE) must be passed: without it Windows allocates a brand-new terminal
 * window for the helper, which stays on screen after the old app is gone.
 * Detached flags are not an option here (CreateFlags 0x8 makes the payload never
 * run, and CreateFlags 0x08000000 is rejected with return value 21), and
 * ProcessStartupInformation only works over the synchronous [wmiclass] call.
 */
export function launchScript(helperPath, resultPath) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$result = [ordered]@{ ok = $false; mode = $null; pid = $null; returnValue = $null; error = $null }',
    '$helper = ' + psQuote(helperPath),
    "    $inner = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + $helper + '\"'",
    'try {',
    '  $startup = ([wmiclass]\'Win32_ProcessStartup\').CreateInstance()',
    '  $startup.ShowWindow = [uint16]0',
    '  $res = ([wmiclass]\'Win32_Process\').Create($inner, $null, $startup)',
    '  $result.returnValue = [int]$res.ReturnValue',
    '  if ($res.ReturnValue -eq 0) {',
    "    $result.ok = $true; $result.mode = 'wmi-cim'; $result.pid = [int]$res.ProcessId",
    '  } else {',
    "    $result.error = 'Win32_Process.Create returned ' + $res.ReturnValue",
    '  }',
    '} catch {',
    "  $result.error = 'cim: ' + $_.Exception.Message",
    '}',
    'if (-not $result.ok) {',
    '  try {',
    '    $out = (& wmic.exe process call create $inner 2>&1 | Out-String)',
    "    if ($out -match 'ProcessId = (\\d+)') {",
    "      $result.ok = $true; $result.mode = 'wmi-wmic'; $result.pid = [int]$Matches[1]; $result.error = $null",
    '    } else {',
    "      $result.error = ([string]$result.error + ' | wmic: ' + $out.Trim())",
    '    }',
    '  } catch {',
    "    $result.error = ([string]$result.error + ' | wmic: ' + $_.Exception.Message)",
    '  }',
    '}',
    '$json = $result | ConvertTo-Json -Compress',
    'Set-Content -LiteralPath ' + psQuote(resultPath) + ' -Value $json -Encoding UTF8',
    'Write-Output $json',
  ]
  return lines.join('\r\n') + '\r\n'
}

/** Reads the launcher outcome from its JSON file (stdout is the fallback). */
function readLaunchResult(resultPath, run) {
  const sources = []
  try {
    sources.push(readFileSync(resultPath, 'utf8'))
  } catch {
    // the launcher may have died before writing its result
  }
  if (run !== null && run !== undefined && typeof run.stdout === 'string') {
    const stdout = run.stdout.trim()
    if (stdout !== '') sources.push(stdout.slice(stdout.lastIndexOf('\n') + 1))
  }
  for (const source of sources) {
    const text = String(source).trim()
    if (text === '') continue
    try {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') {
        return {
          ok: parsed.ok === true,
          mode: typeof parsed.mode === 'string' ? parsed.mode : null,
          pid: typeof parsed.pid === 'number' ? parsed.pid : null,
          error: typeof parsed.error === 'string' ? parsed.error : null
        }
      }
    } catch {
      // try the next source
    }
  }
  return { ok: false, mode: null, pid: null, error: null }
}

/** Waits for the helper's first log line; false when it never arrived. */
function waitForHelperBoot(logPath) {
  const deadline = Date.now() + HELPER_BOOT_TIMEOUT_MS
  const hasBooted = () => {
    try {
      return readFileSync(logPath, 'utf8').includes('helper started')
    } catch {
      return false
    }
  }
  while (Date.now() < deadline) {
    if (hasBooted()) return true
    sleepSync(60)
  }
  return hasBooted()
}

/** Starts the helper that restarts the Desktop app. Throws on launch failure. */
function spawnRestartHelper(exe, appPid) {
  const dir = join(tmpdir(), 'dsh-restart-button')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = join(dir, 'restart-' + stamp + '.log')
  const scriptPath = join(dir, 'restart-' + stamp + '.ps1')
  const launcherPath = join(dir, 'launch-' + stamp + '.ps1')
  const resultPath = join(dir, 'launch-' + stamp + '.json')
  writeFileSync(scriptPath, helperScript(exe, appPid, logPath), 'utf8')
  writeFileSync(launcherPath, launchScript(scriptPath, resultPath), 'utf8')
  const run = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', launcherPath
  ], {
    cwd: dir,
    timeout: LAUNCHER_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8'
  })
  const launch = readLaunchResult(resultPath, run)
  if (!launch.ok) {
    const parts = [launch.error]
    if (run !== null && run !== undefined) {
      if (run.error !== null && run.error !== undefined) parts.push(String(run.error.message))
      if (typeof run.stderr === 'string' && run.stderr.trim() !== '') parts.push(run.stderr.trim())
    }
    const error = new Error('helper launch failed: ' + (parts.filter(Boolean).join(' | ') || 'unknown error'))
    error.logPath = logPath
    error.launcherPath = launcherPath
    throw error
  }
  return {
    helperPid: launch.pid,
    mode: launch.mode,
    logPath,
    scriptPath,
    launcherPath,
    resultPath,
    started: waitForHelperBoot(logPath)
  }
}

function handle(req, res) {
  const pathname = new URL(req.url === undefined ? '/' : req.url, 'http://127.0.0.1').pathname
  if (!isLoopback(req)) {
    reply(res, 403, { ok: false, error: 'loopback only' })
    return undefined
  }
  if (pathname === ROOT + '/status') {
    reply(res, 200, {
      ok: true,
      version: VERSION,
      desktop: process.versions.electron !== undefined,
      executable: desktopExecutable() === null ? null : basename(desktopExecutable()),
      appPid: process.ppid
    })
    return undefined
  }
  if (pathname !== ROOT + '/restart') {
    reply(res, 404, { ok: false, error: 'not found' })
    return undefined
  }
  if (req.method !== 'POST') {
    reply(res, 405, { ok: false, error: 'only POST is allowed' })
    return undefined
  }
  const exe = desktopExecutable()
  if (exe === null) {
    reply(res, 409, { ok: false, error: 'not a desktop host: restart is only available in the DeepSeek Harness desktop app' })
    return undefined
  }
  try {
    const helper = spawnRestartHelper(exe, process.ppid)
    reply(res, 202, {
      ok: true,
      appPid: process.ppid,
      helperPid: helper.helperPid,
      mode: helper.mode,
      started: helper.started,
      log: helper.logPath
    })
  } catch (error) {
    reply(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      log: error !== null && typeof error === 'object' && typeof error.logPath === 'string' ? error.logPath : null
    })
  }
  return undefined
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROOT,
    handler: handle
  }), 'restart-button: /restart-button route')
}
