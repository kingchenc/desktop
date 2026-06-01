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

/** Download a URL to disk, following redirects and reporting progress 0-100. */
function downloadFile(
  url: string,
  destination: string,
  onProgress: (progress: number) => void,
  redirects = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { 'User-Agent': 'GitHubDesktopCustomUpdater' } },
        res => {
          const status = res.statusCode ?? 0
          const location = res.headers.location

          if (status >= 300 && status < 400 && location && redirects > 0) {
            res.resume()
            resolve(downloadFile(location, destination, onProgress, redirects - 1))
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

          file.on('finish', () =>
            file.close(err => (err ? reject(err) : resolve()))
          )
          file.on('error', reject)
          res.on('error', reject)
        }
      )
      .on('error', reject)
  })
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

  // `timeout` gives this app a few seconds to fully quit, then `start` launches
  // the installer. The empty "" is the required window-title argument.
  const command = `timeout /t 4 /nobreak >nul & start "" "${pendingInstallerPath}"`
  const child = spawn('cmd.exe', ['/c', command], {
    detached: true,
    stdio: 'ignore',
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
