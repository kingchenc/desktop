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

/** File in userData that remembers the last release tag we acted on. */
const seenTagFile = () => Path.join(app.getPath('userData'), 'custom-update-tag')

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

function readSeenTag(): string | undefined {
  try {
    // eslint-disable-next-line no-sync
    return fs.readFileSync(seenTagFile(), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function writeSeenTag(tag: string): void {
  try {
    // eslint-disable-next-line no-sync
    fs.writeFileSync(seenTagFile(), tag, 'utf8')
  } catch (e) {
    log.warn(`[CustomUpdater] could not persist tag: ${e}`)
  }
}

/**
 * Run the downloaded installer silently and quit so it can replace the running
 * version without a write-lock conflict.
 */
function installSilentlyAndQuit(installerPath: string): void {
  const child = spawn(installerPath, ['--silent'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  app.quit()
}

/**
 * Check the fork's latest release; if it differs from the last one we acted on,
 * download the installer (reporting progress to the renderer over IPC), then
 * install silently and quit. The first run only seeds the baseline so we never
 * auto-install immediately after a fresh install.
 */
export async function checkForCustomUpdates(
  webContents: WebContents
): Promise<void> {
  if (process.platform !== 'win32') {
    return
  }

  try {
    const release = await fetchLatestRelease()

    if (release === null) {
      return
    }

    const seen = readSeenTag()

    if (seen === undefined) {
      writeSeenTag(release.tag)
      return
    }

    if (seen === release.tag) {
      return
    }

    ipcWebContents.send(webContents, 'custom-update-available', release.tag)

    const destination = Path.join(
      app.getPath('temp'),
      `GitHubDesktopSetup-${release.tag}.exe`
    )

    await downloadFile(release.assetUrl, destination, progress =>
      ipcWebContents.send(webContents, 'custom-update-progress', progress)
    )

    writeSeenTag(release.tag)
    ipcWebContents.send(webContents, 'custom-update-ready')

    installSilentlyAndQuit(destination)
  } catch (e) {
    log.warn(`[CustomUpdater] update check failed: ${e}`)
  }
}
