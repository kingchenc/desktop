import { app, WebContents } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as Path from 'path'
import { spawn } from 'child_process'
import * as ipcWebContents from './ipc-webcontents'

/**
 * The fork whose GitHub Releases drive updates for this custom build. The
 * updater queries this repository's API instead of the official update server.
 */
const UpdateRepo = 'kingchenc/desktop'

/**
 * Path to a downloaded installer that is ready to be applied. Set once an
 * update has been downloaded; the installer is only run when the user chooses
 * to restart (never automatically).
 */
let pendingInstallerPath: string | null = null

interface ICustomRelease {
  readonly tag: string
  readonly assetUrl: string
}

/** GET a URL as JSON, following redirects and sending the required User-Agent. */
function fetchJson(url: string, redirects = 5): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'GitHubDesktopCustomUpdater',
            Accept: 'application/vnd.github+json',
          },
        },
        res => {
          const status = res.statusCode ?? 0
          const location = res.headers.location

          if (status >= 300 && status < 400 && location && redirects > 0) {
            res.resume()
            resolve(fetchJson(location, redirects - 1))
            return
          }

          if (status !== 200) {
            res.resume()
            reject(new Error(`Unexpected status code ${status} for ${url}`))
            return
          }

          const chunks = new Array<Buffer>()
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch (e) {
              reject(e)
            }
          })
        }
      )
      .on('error', reject)
  })
}

const UPDATER_USER_AGENT = 'GitHubDesktopCustomUpdater'

// Number of parallel range connections and the size below which the overhead
// isn't worth it (small assets just use a single stream).
const PARALLEL_CONNECTIONS = 8
const MIN_PARALLEL_BYTES = 8 * 1024 * 1024

/** Single-stream download: follow redirects, stream to disk, report 0-100. */
function downloadFileSingle(
  url: string,
  destination: string,
  onProgress: (progress: number) => void,
  redirects = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UPDATER_USER_AGENT } }, res => {
        const status = res.statusCode ?? 0
        const location = res.headers.location

        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume()
          resolve(downloadFileSingle(location, destination, onProgress, redirects - 1))
          return
        }

        if (status !== 200) {
          res.resume()
          reject(new Error(`Unexpected status code ${status} for ${url}`))
          return
        }

        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let received = 0
        let lastReported = -1

        const file = fs.createWriteStream(destination)

        res.on('data', chunk => {
          received += chunk.length
          if (total > 0) {
            const progress = Math.floor((received / total) * 100)
            if (progress !== lastReported) {
              lastReported = progress
              onProgress(progress)
            }
          }
        })

        res.pipe(file)

        file.on('finish', () => file.close(err => (err ? reject(err) : resolve())))
        file.on('error', reject)
        res.on('error', reject)
      })
      .on('error', reject)
  })
}

interface IDownloadProbe {
  readonly finalUrl: string
  readonly total: number
  readonly acceptsRanges: boolean
}

/**
 * Follow redirects with a one-byte ranged request to discover the final asset
 * URL, its total size and whether the server honours range requests. GitHub
 * release assets redirect github.com -> objects.githubusercontent.com, and the
 * final host serves 206 Partial Content - which is what lets us parallelise.
 */
function probeDownload(url: string, redirects = 5): Promise<IDownloadProbe> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { 'User-Agent': UPDATER_USER_AGENT, Range: 'bytes=0-0' } },
        res => {
          const status = res.statusCode ?? 0
          const location = res.headers.location
          res.resume()

          if (status >= 300 && status < 400 && location && redirects > 0) {
            resolve(probeDownload(location, redirects - 1))
            return
          }

          if (status === 206) {
            // content-range: "bytes 0-0/<total>"
            const range = String(res.headers['content-range'] ?? '')
            const total = parseInt(range.slice(range.indexOf('/') + 1), 10)
            resolve({ finalUrl: url, total, acceptsRanges: total > 0 })
            return
          }

          if (status === 200) {
            const total = parseInt(res.headers['content-length'] ?? '0', 10)
            resolve({ finalUrl: url, total, acceptsRanges: false })
            return
          }

          reject(new Error(`Unexpected status code ${status} probing ${url}`))
        }
      )
      .on('error', reject)
  })
}

/** Download one byte range to its own part file. Only 206 responses accepted. */
function downloadChunkToFile(
  url: string,
  start: number,
  end: number,
  partPath: string,
  onBytes: (count: number) => void,
  redirects = 3
): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': UPDATER_USER_AGENT,
            Range: `bytes=${start}-${end}`,
          },
        },
        res => {
          const status = res.statusCode ?? 0
          const location = res.headers.location

          if (status >= 300 && status < 400 && location && redirects > 0) {
            res.resume()
            resolve(
              downloadChunkToFile(location, start, end, partPath, onBytes, redirects - 1)
            )
            return
          }

          // A 200 here means the server ignored the range and would send the
          // whole file into this part - unusable for a parallel assembly.
          if (status !== 206) {
            res.resume()
            reject(new Error(`Expected 206 for range ${start}-${end}, got ${status}`))
            return
          }

          const file = fs.createWriteStream(partPath)
          res.on('data', chunk => onBytes(chunk.length))
          res.pipe(file)
          file.on('finish', () => file.close(err => (err ? reject(err) : resolve())))
          file.on('error', reject)
          res.on('error', reject)
        }
      )
      .on('error', reject)
  })
}

/**
 * Download an asset in parallel byte ranges, then concatenate the parts. GitHub
 * throttles per connection, so several ranges at once recover full bandwidth
 * (the same trick a multi-connection download manager uses). Part files are
 * always cleaned up, even on failure.
 */
async function downloadParallel(
  finalUrl: string,
  total: number,
  destination: string,
  onProgress: (progress: number) => void,
  connections: number
): Promise<void> {
  const chunkSize = Math.ceil(total / connections)
  const parts = new Array<{ path: string; start: number; end: number; index: number }>()

  for (let i = 0; i < connections; i++) {
    const start = i * chunkSize
    if (start >= total) {
      break
    }
    const end = Math.min(start + chunkSize - 1, total - 1)
    parts.push({ path: `${destination}.part${i}`, start, end, index: i })
  }

  // Per-chunk byte counters so a retried chunk simply overwrites its own count
  // instead of double-reporting aggregate progress.
  const chunkBytes = new Array<number>(parts.length).fill(0)
  let lastReported = -1
  const report = () => {
    const received = chunkBytes.reduce((a, b) => a + b, 0)
    const progress = Math.floor((received / total) * 100)
    if (progress !== lastReported) {
      lastReported = progress
      onProgress(progress)
    }
  }

  const downloadWithRetry = async (part: {
    path: string
    start: number
    end: number
    index: number
  }) => {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      chunkBytes[part.index] = 0
      report()
      try {
        await downloadChunkToFile(finalUrl, part.start, part.end, part.path, count => {
          chunkBytes[part.index] += count
          report()
        })
        return
      } catch (e) {
        lastError = e
      }
    }
    throw lastError
  }

  const cleanup = async () => {
    for (const part of parts) {
      try {
        await fs.promises.unlink(part.path)
      } catch {
        // part may not exist if its download never started - ignore.
      }
    }
  }

  try {
    await Promise.all(parts.map(downloadWithRetry))

    // Concatenate the parts (already in offset order) into the destination.
    await fs.promises.writeFile(destination, Buffer.alloc(0))
    for (const part of parts) {
      await fs.promises.appendFile(destination, await fs.promises.readFile(part.path))
    }
  } finally {
    await cleanup()
  }
}

/**
 * Download a URL to disk reporting progress 0-100. Tries a parallel multi-range
 * download (much faster against GitHub's per-connection throttling) and falls
 * back to a single stream if the asset is small or the server doesn't support
 * ranges, or if the parallel attempt fails for any reason.
 */
async function downloadFile(
  url: string,
  destination: string,
  onProgress: (progress: number) => void
): Promise<void> {
  try {
    const probe = await probeDownload(url)

    if (
      !probe.acceptsRanges ||
      probe.total < MIN_PARALLEL_BYTES ||
      PARALLEL_CONNECTIONS <= 1
    ) {
      await downloadFileSingle(url, destination, onProgress)
      return
    }

    await downloadParallel(
      probe.finalUrl,
      probe.total,
      destination,
      onProgress,
      PARALLEL_CONNECTIONS
    )
  } catch (e) {
    log.warn(
      `[CustomUpdater] parallel download failed, falling back to single stream: ${e}`
    )
    await downloadFileSingle(url, destination, onProgress)
  }
}

async function fetchLatestRelease(): Promise<ICustomRelease | null> {
  const data = await fetchJson(
    `https://api.github.com/repos/${UpdateRepo}/releases/latest`
  )

  const tag = typeof data?.tag_name === 'string' ? data.tag_name : null
  const assets: ReadonlyArray<any> = Array.isArray(data?.assets)
    ? data.assets
    : []

  const exe = assets.find(
    a =>
      typeof a?.name === 'string' &&
      a.name.toLowerCase().endsWith('.exe') &&
      typeof a?.browser_download_url === 'string'
  )

  if (tag === null || exe === undefined) {
    return null
  }

  return { tag, assetUrl: exe.browser_download_url }
}

/**
 * Apply a previously downloaded update. Only ever called when the user chooses
 * to restart - never automatically.
 *
 * The work is handed to a single, detached, HIDDEN PowerShell helper so this
 * process can fully exit before the installer touches the installation. Running
 * the full Setup.exe while the app still holds its files makes Squirrel skip the
 * real upgrade, so we never run it from a live process.
 *
 * Returns false (and surfaces an error to the renderer) if there is nothing
 * valid to install; returns true once the helper has been launched and the app
 * has been asked to quit.
 */
export function installPendingCustomUpdate(webContents?: WebContents): boolean {
  const tempDir = app.getPath('temp')
  const logPath = Path.join(tempDir, 'github-desktop-custom-update.log')

  // Node-side breadcrumb so a failure is always diagnosable even if the helper
  // never starts - the previous implementation logged ONLY from inside the
  // spawned PowerShell, so a silent spawn failure left no trace at all.
  const appendLog = (line: string) => {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\r\n`)
    } catch {
      // Logging must never block applying an update.
    }
  }

  const fail = (message: string, error?: unknown) => {
    appendLog(error ? `${message}: ${error}` : message)
    log.error(`[CustomUpdater] ${message}`, error instanceof Error ? error : undefined)
    if (webContents !== undefined) {
      ipcWebContents.send(
        webContents,
        'auto-updater-error',
        new Error(`Could not apply the downloaded update: ${message}`)
      )
    }
    return false
  }

  if (pendingInstallerPath === null) {
    return fail('no update has been downloaded to install')
  }

  const installerPath = pendingInstallerPath

  if (!fs.existsSync(installerPath)) {
    pendingInstallerPath = null
    return fail(`the downloaded installer is missing: ${installerPath}`)
  }

  // Start a fresh log for this attempt (a stale log from a prior session is
  // misleading when diagnosing "nothing happened").
  try {
    fs.writeFileSync(logPath, '')
  } catch {
    // ignore - appendLog below is best-effort too.
  }
  appendLog(`install starting: installer=${installerPath} pid=${process.pid}`)

  // The Squirrel root-stub launcher (one directory above app-x.y.z) used as a
  // safety net if Setup.exe does not relaunch the app itself.
  const launcher = Path.join(
    Path.dirname(Path.dirname(process.execPath)),
    Path.basename(process.execPath)
  )

  // Resolve powershell.exe by absolute path rather than relying on PATH, which
  // is not guaranteed in every launch context (a missing PATH entry would make
  // spawn() fail silently and the update would never apply).
  const powershell = Path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )

  const psQuote = (value: string) => value.replace(/'/g, "''")
  const escLog = psQuote(logPath)

  // The helper, in order:
  //   1. wait for THIS process (the Electron main) to exit, and
  //   2. wait until NO GitHubDesktop.exe remains. Electron leaves several
  //      helper processes (GPU/renderer/utility/crashpad) that share that image
  //      name and exit slightly after the main process. GitHub Desktop's
  //      Squirrel Setup.exe only runs ApplyReleases (the real upgrade) when the
  //      app is fully gone - otherwise it does housekeeping (updateSelf +
  //      createShortcut) and silently skips the new version. Waiting on the
  //      main PID alone (the previous approach) did not close this gap.
  //   3. run the installer visibly (Squirrel shows its progress and auto-starts
  //      the new app), then
  //   4. only relaunch as a safety net if the app is not already running.
  // All waiting uses in-process cmdlets (Wait-Process / Get-Process), so there
  // are no flashing console windows like the old tasklist/ping batch loop.
  const psScript = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `function Log($m){ Add-Content -LiteralPath '${escLog}' -Value ("{0} {1}" -f (Get-Date -Format o), $m) }`,
    `Log 'waiting for app pid ${process.pid}'`,
    `try { Wait-Process -Id ${process.pid} -Timeout 120 -ErrorAction Stop } catch { Log 'pid wait ended (already exited or timed out)' }`,
    `for ($i=0; $i -lt 120; $i++) { if (-not (Get-Process -Name GitHubDesktop -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }`,
    `Log 'app fully stopped; running installer'`,
    `$proc = Start-Process -FilePath '${psQuote(
      installerPath
    )}' -Wait -PassThru`,
    `Log ('installer exit ' + $proc.ExitCode)`,
    `Start-Sleep -Seconds 3`,
    `if (Get-Process -Name GitHubDesktop -ErrorAction SilentlyContinue) { Log 'app already running after install' } else { Log 'relaunching app'; Start-Process -FilePath '${psQuote(
      launcher
    )}' }`,
    `Log 'done'`,
  ].join('\r\n')

  // Write the helper to a .ps1 file and launch it via `cmd /c start`. This is
  // THE fix for "restart did nothing": a plain detached + unref'd child is
  // still torn down when the app exits ~10ms later (PowerShell never finishes
  // starting), so the old helper never ran - the log only ever showed the
  // Node-side lines and stopped. `start` creates a genuinely independent
  // process that breaks away from the app's process tree and survives
  // app.quit(). Launching a -File script (rather than a -Command string) keeps
  // cmd's start parser away from the script's ; () {} characters.
  const scriptPath = Path.join(tempDir, 'github-desktop-apply-update.ps1')
  try {
    fs.writeFileSync(scriptPath, psScript, 'utf8')
  } catch (e) {
    return fail('could not write the update helper script', e)
  }

  try {
    const child = spawn(
      'cmd.exe',
      [
        '/c',
        'start',
        '/min',
        '""',
        powershell,
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }
    )
    child.on('error', err => fail('failed to launch the update helper', err))
    child.unref()
  } catch (e) {
    return fail('could not start the update helper', e)
  }

  appendLog(`update helper launched (${scriptPath}); quitting app`)
  app.quit()
  return true
}

/**
 * Check the fork's latest release. If it differs from the tag THIS build was
 * packaged as, download the installer (reporting progress) and notify the
 * renderer that an update is ready. The installer is NEVER run automatically -
 * the user applies it via the "Restart" action (installPendingCustomUpdate),
 * which only runs it after the app has exited.
 */
let checkInFlight = false

export async function checkForCustomUpdates(
  webContents: WebContents
): Promise<void> {
  // Guard against overlapping checks (e.g. the launch check and a manual
  // "Check for Updates" firing together) downloading twice.
  if (checkInFlight) {
    return
  }
  checkInFlight = true

  // Mirror the lifecycle on the existing auto-updater channels so the in-app
  // update UI (About dialog, menu) reflects the fork check without changes.
  ipcWebContents.send(webContents, 'auto-updater-checking-for-update')

  try {
    // Already downloaded this session - just resurface the "ready" state.
    if (pendingInstallerPath !== null) {
      ipcWebContents.send(webContents, 'auto-updater-update-downloaded')
      return
    }

    if (process.platform !== 'win32') {
      ipcWebContents.send(webContents, 'auto-updater-update-not-available')
      return
    }

    const release = await fetchLatestRelease()

    if (release === null) {
      ipcWebContents.send(webContents, 'auto-updater-update-not-available')
      return
    }

    // Compare against the tag this build was packaged as. An empty tag means a
    // local/dev build, which never auto-updates.
    if (__CUSTOM_UPDATE_TAG__ === '' || release.tag === __CUSTOM_UPDATE_TAG__) {
      ipcWebContents.send(webContents, 'auto-updater-update-not-available')
      return
    }

    ipcWebContents.send(webContents, 'auto-updater-update-available')
    ipcWebContents.send(webContents, 'custom-update-available', release.tag)

    const destination = Path.join(
      app.getPath('temp'),
      `GitHubDesktopSetup-${release.tag}.exe`
    )

    await downloadFile(release.assetUrl, destination, progress =>
      ipcWebContents.send(webContents, 'custom-update-progress', progress)
    )

    // Mark the update as ready, but DO NOT install. The user applies it from
    // the "Restart" prompt; installing from a live process can corrupt things.
    pendingInstallerPath = destination
    ipcWebContents.send(webContents, 'auto-updater-update-downloaded')
    ipcWebContents.send(webContents, 'custom-update-ready')
  } catch (e) {
    log.warn(`[CustomUpdater] update check failed: ${e}`)
    ipcWebContents.send(
      webContents,
      'auto-updater-error',
      e instanceof Error ? e : new Error(String(e))
    )
  } finally {
    checkInFlight = false
  }
}
