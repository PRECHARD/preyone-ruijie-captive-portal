/**
 * Generates responsive image variants for the captive portal (public/images).
 *
 * The portal is served to users who are mid-captive-auth on a constrained mobile
 * connection, and the header logo is the largest paint. These sources ship
 * enormously oversized: the header logo was a 236 KB PNG for a box that never
 * exceeds 800 CSS px, the feature icons were 1024x1024 PNGs (~2.2 MB total)
 * painted into 80x80 circles, and the loading spinner was a 79 KB PNG base64-
 * embedded inside an SVG (105 KB on the wire) shown at 40x40 px.
 *
 * Emits WebP + AVIF at the widths the CSS actually uses, plus a PNG fallback,
 * so browsers pick the smallest asset that fits their device pixel ratio.
 *
 * Run with: npm run optimize:portal
 */
import sharp from 'sharp'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const imagesDir = path.resolve(__dirname, '../public/images')
mkdirSync(imagesDir, { recursive: true })

/** Widths are the rendered CSS width x the DPR we are willing to pay for. */
const targets = [
  {
    // Header logo: .brand-logo-img is width:100% with max-width:800px.
    src: 'preyonenoneglow-logo-optimized.png',
    name: 'preyonenoneglow-logo',
    widths: [400, 800],
  },
  {
    // Footer mark: .footer-brand-mark, much smaller than the header logo.
    src: 'preyone-logo-mainInverse-optimized.png',
    name: 'preyone-logo-mainInverse',
    widths: [400],
  },
  // Feature icons: .feature-icon is a fixed 80x80 box. 160 covers 2x DPR.
  ...['icon-fast', 'icon-reliable', 'icon-multi', 'icon-support'].map((name) => ({
    src: `${name}.png`,
    name,
    widths: [160],
  })),
]

/**
 * The loading spinner used to be an SVG wrapping a base64 PNG — 79 KB of raster
 * inflated to 105 KB on the wire, painted at 40x40 px as the first thing the
 * portal renders. The raster was extracted once into scripts/assets/ (kept out of
 * public/ so it is not served) and is now emitted as a real small image.
 */
const spinnerName = 'faviconloading'
const spinnerSource = path.resolve(__dirname, 'assets/faviconloading-source.png')

function human(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

async function emit(name, inputPath, widths) {
  const width = widths[0]
  const base = sharp(inputPath).rotate().resize({ width, withoutEnlargement: true })
  const results = []

  // AVIF first: it is the smallest and every current browser we target supports it.
  const avif = await base.clone().avif({ quality: 60, effort: 6 }).toBuffer()
  await writeFileSync(path.join(imagesDir, `${name}-${width}.avif`), avif)
  results.push(`avif ${human(avif.byteLength)}`)

  const webp = await base.clone().webp({ quality: 82, effort: 6 }).toBuffer()
  await writeFileSync(path.join(imagesDir, `${name}-${width}.webp`), webp)
  results.push(`webp ${human(webp.byteLength)}`)

  // PNG fallback only for the smallest width, so legacy browsers get one
  // reasonable file instead of the full-resolution original.
  const png = await base.clone().png({ compressionLevel: 9, palette: true }).toBuffer()
  await writeFileSync(path.join(imagesDir, `${name}-${width}.png`), png)
  results.push(`png ${human(png.byteLength)}`)

  return results
}

async function run() {
  let totalBefore = 0
  let totalAfter = 0

  if (existsSync(spinnerSource)) {
    // The spinner is painted at 40x40 CSS px, so 80 covers 2x DPR comfortably.
    const sizes = await emit(spinnerName, spinnerSource, [80])
    const before = readFileSync(spinnerSource).length
    const after = readFileSync(path.join(imagesDir, `${spinnerName}-80.webp`)).length
    totalBefore += before
    totalAfter += after
    console.log(`${spinnerName} @80 -> ${sizes.join(', ')}\n  (was a 105 KB base64 SVG for a 40px spinner)`)
  } else {
    console.warn(`! missing ${spinnerSource}, skipping spinner`)
  }

  for (const t of targets) {
    const inputPath = path.join(imagesDir, t.src)
    if (!existsSync(inputPath)) {
      console.warn(`! missing source ${t.src}, skipping ${t.name}`)
      continue
    }
    const before = readFileSync(inputPath).length
    totalBefore += before
    const lines = []
    for (const w of t.widths) {
      lines.push(`${w}w: ${(await emit(t.name, inputPath, [w])).join(', ')}`)
    }
    // Cheapest variant the smallest screen will ever fetch.
    const smallest = readFileSync(path.join(imagesDir, `${t.name}-${t.widths[0]}.webp`)).length
    totalAfter += smallest
    console.log(`${t.name} (${human(before)} png) ->\n  ${lines.join('\n  ')}`)
  }

  console.log(
    `\nBefore: ${human(totalBefore)} of above-the-fold imagery\n` +
      `After:  ~${human(totalAfter)} for a typical phone\n` +
      `Saved:  ~${human(totalBefore - totalAfter)}`
  )
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
