// Cover-derived spine tints: sample the real cover, keep its dominant
// hue (the matching signal), and mute saturation/lightness into the
// book-cloth range so the shelf stays editorial and gilt titles stay
// legible. Pure half (pickClothHue) is vitest-covered; the browser half
// (sampleCoverTint) touches Image/canvas and memoizes per book.

export interface RgbSample {
  r: number
  g: number
  b: number
}

/** A pixel votes only when it is genuinely chromatic — below-sat grays and
 *  blown blacks/whites never vote (they produced whole-cover "hue 0"
 *  artifacts in early sampling). */
const VOTE_MIN_SAT = 0.2
/** Winning hue bins must hold at least this share of ALL pixels: a logo
 *  under 10% of the cover does not define the cloth. */
const MIN_SHARE = 0.1
const N_BINS = 24 // 15-degree hue bins
/** The muted-match clamp — sits inside the real CLOTHS envelope. */
const SAT_RANGE: [number, number] = [0.17, 0.32]
const LIGHT_RANGE: [number, number] = [0.16, 0.38]

interface Bin {
  count: number
  score: number
  sinSum: number
  cosSum: number
  satW: number
  lightW: number
}

function emptyBins(): Bin[] {
  return Array.from({ length: N_BINS }, () => ({
    count: 0, score: 0, sinSum: 0, cosSum: 0, satW: 0, lightW: 0,
  }))
}

/** RGB → HSL (h in degrees [0,360), s/l in [0,1]). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
  else if (max === gn) h = ((bn - rn) / d + 2) * 60
  else h = ((rn - gn) / d + 4) * 60
  return [h, s, l]
}

/**
 * Dominant cloth hue from sampled cover pixels, or null when the cover is
 * effectively neutral or its color is too small a share. Hue is exact
 * (circular weighted mean over the winning bins); saturation/lightness are
 * score-weighted means clamped into the muted range.
 */
export function pickClothHue(samples: RgbSample[]): string | null {
  if (!samples.length) return null
  const bins = emptyBins()
  let total = 0
  for (const { r, g, b } of samples) {
    total++
    const [h, s, l] = rgbToHsl(r, g, b)
    if (s < VOTE_MIN_SAT || l <= 0.05 || l >= 0.95) continue
    const w = s * (1 - Math.abs(l - 0.33))
    const bin = bins[Math.floor(h / 15) % N_BINS]
    const rad = (h * Math.PI) / 180
    bin.count++
    bin.score += w
    bin.sinSum += w * Math.sin(rad)
    bin.cosSum += w * Math.cos(rad)
    bin.satW += w * s
    bin.lightW += w * l
  }
  if (total === 0) return null
  // circular neighbor merge: split hues (350° + 5° reds) must resolve to
  // one family instead of losing to noise
  let best = -1
  let bestScore = -1
  for (let i = 0; i < N_BINS; i++) {
    const eff = bins[i].score + 0.5 * bins[(i + N_BINS - 1) % N_BINS].score
                       + 0.5 * bins[(i + 1) % N_BINS].score
    if (eff > bestScore) {
      bestScore = eff
      best = i
    }
  }
  if (best < 0) return null
  const merged = [bins[(best + N_BINS - 1) % N_BINS], bins[best], bins[(best + 1) % N_BINS]]
  const share =
    (merged[0].count + merged[1].count + merged[2].count) / total
  if (share < MIN_SHARE) return null
  const sinSum = merged.reduce((a, x) => a + x.sinSum, 0)
  const cosSum = merged.reduce((a, x) => a + x.cosSum, 0)
  const score = merged.reduce((a, x) => a + x.score, 0)
  const satW = merged.reduce((a, x) => a + x.satW, 0)
  const lightW = merged.reduce((a, x) => a + x.lightW, 0)
  if (score <= 0) return null
  const hue = ((Math.atan2(sinSum, cosSum) * 180) / Math.PI + 360) % 360
  const sat = Math.min(SAT_RANGE[1], Math.max(SAT_RANGE[0], satW / score))
  const light = Math.min(LIGHT_RANGE[1], Math.max(LIGHT_RANGE[0], lightW / score))
  return `hsl(${Math.round(hue)} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%)`
}

/** Memoizes the promise — concurrent mounts dedupe, and null results (404,
 *  grayscale) are cached so nothing re-samples within a session. */
const tintCache = new Map<string, Promise<string | null>>()

export function clearCoverTintCache(id?: string): void {
  if (id === undefined) tintCache.clear()
  else tintCache.delete(id)
}

function sample(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image()
      img.decoding = 'async'
      img.onerror = () => resolve(null)
      img.onload = () => {
        try {
          // small enough to be instant, big enough for a dominant hue
          const W = 24
          const H = 36
          const canvas = document.createElement('canvas')
          canvas.width = W
          canvas.height = H
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (!ctx) return resolve(null)
          ctx.drawImage(img, 0, 0, W, H)
          const data = ctx.getImageData(0, 0, W, H).data
          const samples: RgbSample[] = []
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue // transparent PNG
            samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] })
          }
          resolve(pickClothHue(samples))
        } catch {
          resolve(null)
        }
      }
      img.src = url
    } catch {
      resolve(null)
    }
  })
}

/** Browser-only: cover URL → spine tint (or null), memoized per book id. */
export function sampleCoverTint(id: string, url: string): Promise<string | null> {
  let p = tintCache.get(id)
  if (!p) {
    p = sample(url)
    tintCache.set(id, p)
  }
  return p
}
