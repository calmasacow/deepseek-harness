/**
 * Post-install adjustments the Linux release needs because neither Electron nor the
 * published dependency set has ever been qualified against it.
 *
 * The Windows and macOS releases never needed either adjustment, so they keep the
 * registry packages exactly as installed.
 *
 * 1. `sharp` embeds a private glib inside libvips that collides with the system glib
 *    Electron links for GTK. The first image decode then unrefs a GObject through the
 *    wrong glib and the process dies with SIGSEGV (electron/electron#46323), which no
 *    runtime flag fixes. `@janhapke/sharp-electron` is sharp rebuilt with the colliding
 *    symbols renamed at link time.
 * 2. LibreOfficeKit decides whether an optional native engine package is installed by
 *    probing `lstatSync(path, { throwIfNoEntry: false })`. Electron's ASAR filesystem
 *    returns `null` rather than `undefined` for a missing entry, so the probe reports
 *    every name as installed and Linux can never fall back to the bundled WASM engine:
 *    conversion fails with "installed package is incomplete" instead.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DesktopTargetName } from './desktop-build-paths.mjs'

/** Package that carries the sharp rebuild matching the workspace's sharp version. */
const SHARP_PACKAGE = '@janhapke/sharp-electron'
/**
 * Newest published rebuild. Upstream's sharp moved to 0.35.5, which has no rebuild yet,
 * so the Linux runtime ships the 0.35.4 rebuild, whose JavaScript and native halves are
 * the same version and replace the registry package together.
 */
const SHARP_VERSION = '0.35.4-electron.1'

/**
 * SHA-256 of the published sharp tarball.
 * A mismatch stops packaging instead of shipping binaries nobody verified.
 */
const SHARP_SHA256 = 'af967ccc9e306e36a92cd017bc6121ab06521c8fc4d3bc642d3e90f62e3e44c6'

/** Package the sharp rebuild replaces, and the registry binaries it makes dead weight. */
const SHARP_DESTINATION = 'sharp'
const REPLACED_SHARP_PACKAGES = ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']

/** Engine package family whose bundles decide whether the optional native engine is installed. */
const OFFICE_ENGINE_PACKAGE = '@deepseek-ai/libreoffice-kit'

/** ASAR-insensitive existence probe that replaces the published one. */
const OFFICE_ENGINE_EXISTENCE_CHECK = 'lstatSync(join(directory, name), { throwIfNoEntry: false }) !== void 0'
const OFFICE_ENGINE_EXISTENCE_FIX = 'Boolean(lstatSync(join(directory, name), { throwIfNoEntry: false }))'

function sharpTarballUrl(): string {
  return `https://registry.npmjs.org/${SHARP_PACKAGE.replace('/', '%2F')}/-/${
    SHARP_PACKAGE.split('/')[1]}-${SHARP_VERSION}.tgz`
}

/**
 * Return the verified sharp tarball, downloading it only when the shared cache lacks it.
 * @param cache - Directory shared with the other pinned packaging downloads.
 * @returns Path of the checksum-addressed archive.
 */
async function sharpArchive(cache: string): Promise<string> {
  mkdirSync(cache, { recursive: true })
  const destination = join(cache, SHARP_SHA256)
  let bytes: Buffer
  try {
    bytes = readFileSync(destination)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const response = await fetch(sharpTarballUrl())
    if (!response.ok) throw new Error(`electron-safe sharp download: ${String(response.status)} ${sharpTarballUrl()}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(bytes).digest('hex') !== SHARP_SHA256) {
    rmSync(destination, { force: true })
    throw new Error(`electron-safe sharp download: checksum mismatch for ${sharpTarballUrl()}`)
  }
  if (!existsSync(destination)) writeFileSync(destination, bytes)
  return destination
}

/**
 * Swap the runtime's sharp package for the Electron-safe rebuild.
 * @param root - Prepared dsh tree that becomes `resources/app.asar/dsh`.
 * @param cache - Directory shared with the other pinned packaging downloads.
 * @param target - Release target; only linux-x64 has a rebuild published.
 * @throws When the rebuild has no build for the target, or the installed tree is unexpected.
 */
export async function installElectronSafeSharp(
  root: string,
  cache: string,
  target: DesktopTargetName,
): Promise<void> {
  const modules = join(root, 'node_modules')
  const destination = join(modules, SHARP_DESTINATION)
  if (!existsSync(destination) || !statSync(destination).isDirectory()) {
    throw new Error(`electron-safe sharp: ${destination} is not an installed package directory`)
  }
  if (target !== 'linux-x64') {
    throw new Error(`electron-safe sharp: no rebuilt sharp is published for ${target}`)
  }
  const archive = await sharpArchive(cache)
  const staging = join(cache, `extract-${SHARP_SHA256}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', staging])
  const source = join(staging, 'package', 'linux-x64', SHARP_DESTINATION)
  if (!existsSync(join(source, 'src', 'build', 'Release'))) {
    throw new Error(`electron-safe sharp: ${archive} does not contain a linux-x64 build`)
  }
  rmSync(destination, { recursive: true, force: true })
  cpSync(source, destination, { recursive: true, dereference: true })
  // The replaced native libraries are dead weight once the rebuild is in place, and shipping
  // them would leave the crashing artifacts in the application.
  for (const name of REPLACED_SHARP_PACKAGES) {
    rmSync(join(modules, ...name.split('/')), { recursive: true, force: true })
  }
  rmSync(staging, { recursive: true, force: true })
}

/**
 * List the JavaScript files of a prepared runtime.
 * @param directory - Directory to walk.
 * @returns Every `.js` file below it, as absolute paths.
 */
function javascriptFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...javascriptFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(path)
  }
  return found
}

/**
 * Make the LibreOfficeKit engine probe work inside an ASAR archive.
 *
 * The probe is not confined to one file: the engine ships it in its converter, its CLI
 * worker and its editor, and the office kit carries its own copy of the same decision.
 * Patching a single bundle leaves conversion failing with "installed package is
 * incomplete", so every runtime script carrying the probe is rewritten.
 *
 * @param root - Prepared dsh tree that becomes `resources/app.asar/dsh`.
 * @throws When a script carries the probe more than once, or none carries it.
 */
export function fixLibreOfficeEngineFallback(root: string): void {
  const modules = join(root, 'node_modules')
  let patched = 0
  for (const path of javascriptFiles(modules)) {
    const source = readFileSync(path, 'utf8')
    const occurrences = source.split(OFFICE_ENGINE_EXISTENCE_CHECK).length - 1
    if (occurrences === 0) continue
    if (occurrences !== 1) {
      throw new Error(`desktop runtime: ${path} carries ${occurrences} installed-package probes this build cannot patch`)
    }
    writeFileSync(path, source.replace(OFFICE_ENGINE_EXISTENCE_CHECK, OFFICE_ENGINE_EXISTENCE_FIX))
    patched += 1
  }
  if (patched === 0) {
    throw new Error(`desktop runtime: no installed-package probe to patch for the ${OFFICE_ENGINE_PACKAGE} fallback`)
  }
}
