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
 * The installer is launched through a short delay so this process can fully
 * exit first. Running the full Setup.exe while the app still holds its files
 * can wipe/corrupt the installation, so we never run it from a live process.
 * Returns false if there is nothing to install.
 */
export function installPendingCustomUpdate(): boolean {
  if (pendingInstallerPath === null) {
    return false
  }

  // Hand the install off to a detached batch script that waits for this app to
  // exit, runs the installer, then relaunches the app. A batch file is used
  // (rather than an inline `cmd /c "..."` or PowerShell -Command) because:
  //   * passing a single script path avoids Node's cmd quote-mangling, which
  //     previously corrupted the installer path ("file not found"),
  //   * `ping` provides the settle delay without needing a console (unlike
  //     `timeout`), and
  //   * every step is logged to a file so a failed update is diagnosable.
  // The installer is launched visibly so any OS prompt (e.g. SmartScreen for
  // the unsigned build) is shown rather than blocking invisibly. The relaunch
  // targets the stable root launcher (one level above the versioned app-x dir)
  // so it starts whatever build was just installed.
  const tempDir = app.getPath('temp')
  const logPath = Path.join(tempDir, 'github-desktop-custom-update.log')
  const batchPath = Path.join(tempDir, 'github-desktop-custom-update.cmd')
  const exeName = Path.basename(process.execPath)
  const launcher = Path.join(
    Path.dirname(Path.dirname(process.execPath)),
    exeName
  )

  const batch = [
    '@echo off',
    `echo [%date% %time%] update starting > "${logPath}"`,
    // Wait until this app has FULLY exited before running the installer. If the
    // process is still alive Squirrel's Setup.exe bails to "already running,
    // just launch" mode and never applies the new version - which is exactly
    // why a fixed sleep failed. Poll tasklist, capped so we can never hang.
    'set /a tries=0',
    ':waitloop',
    `tasklist /fi "imagename eq ${exeName}" 2>nul | find /i "${exeName}" >nul`,
    'if errorlevel 1 goto exited',
    'set /a tries+=1',
    'if %tries% geq 30 goto exited',
    'ping -n 3 127.0.0.1 >nul 2>&1',
    'goto waitloop',
    ':exited',
    `echo [%date% %time%] app exited after %tries% checks, running installer >> "${logPath}"`,
    `"${pendingInstallerPath}" >> "${logPath}" 2>&1`,
    `echo [%date% %time%] installer exit code %errorlevel% >> "${logPath}"`,
    `echo [%date% %time%] relaunching app >> "${logPath}"`,
    `start "" "${launcher}"`,
    `echo [%date% %time%] done >> "${logPath}"`,
  ].join('\r\n')

  try {
    fs.writeFileSync(batchPath, batch, 'utf8')
  } catch (e) {
    log.error(`[CustomUpdater] failed to write update script: ${e}`)
    return false
  }

  const child = spawn('cmd.exe', ['/c', batchPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

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
