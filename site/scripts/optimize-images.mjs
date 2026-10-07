import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const imagesDir = path.resolve(__dirname, '../public/images')
mkdirSync(imagesDir, { recursive: true })

const sources = [
  {
    src: 'preyonenoneglow-logo-optimized.png',
    name: 'preyonenoneglow-logo',
    width: 960,
    webp: true,
    avif: true,
  },
  {
    src: 'preyone-logo-mainInverse-optimized.png',
    name: 'preyone-logo-mainInverse',
    width: 960,
    webp: true,
    avif: true,
  },
  {
    src: 'starlink-mini-kit.png',
    name: 'starlink-mini-kit',
    width: 720,
    webp: true,
    avif: false,
  },
  {
    src: 'starlink-standard-kit.png',
    name: 'starlink-standard-kit',
    width: 720,
    webp: true,
    avif: false,
  },
]

function human(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

async function run() {
  for (const entry of sources) {
    const inputPath = path.join(imagesDir, entry.src)
    const base = await sharp(inputPath).rotate().resize({
      width: entry.width,
      withoutEnlargement: true,
    })

    const formats = []
    if (entry.webp) {
      const buf = await base.webp({ quality: 78, effort: 4 }).toBuffer()
      await sharp(buf).toFile(path.join(imagesDir, `${entry.name}.webp`))
      formats.push(`webp ${human(buf.byteLength)}`)
    }
    if (entry.avif) {
      const buf = await base.avif({ quality: 55, effort: 4 }).toBuffer()
      await sharp(buf).toFile(path.join(imagesDir, `${entry.name}.avif`))
      formats.push(`avif ${human(buf.byteLength)}`)
    }
    const sourceStats = await sharp(inputPath).metadata()
    console.log(entry.name, '->', formats.join(' | '), '(source', human(sourceStats.size ?? 0) + ')')
  }
  console.log('Done. WebP/AVIF optimized assets written to public/images.')
}

run().catch((err) => {
  console.error('Image optimization failed:', err)
  process.exit(1)
})