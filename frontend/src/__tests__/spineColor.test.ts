// pickClothHue contract: the cover's hue, muted into cloth range — or null
// when the cover has no definable color. Pure; test-local hsl→rgb factory.

import { describe, expect, it } from 'vitest'
import { pickClothHue, type RgbSample } from '../library/spineColor'

function hsl(h: number, s: number, l: number): RgbSample {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
    return Math.round(v * 255)
  }
  return { r: f(0), g: f(8), b: f(4) }
}

function many(n: number, make: (i: number) => RgbSample): RgbSample[] {
  return Array.from({ length: n }, make)
}

function parse(out: string) {
  const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(out)
  expect(m).not.toBeNull()
  return { h: Number(m![1]), s: Number(m![2]), l: Number(m![3]) }
}

describe('pickClothHue', () => {
  it('keeps a vivid teal cover hue, muted into cloth range', () => {
    const out = pickClothHue(many(400, () => hsl(184, 0.7, 0.35)))
    const { h, s, l } = parse(out!)
    expect(Math.abs(h - 184)).toBeLessThanOrEqual(2)
    expect(s).toBeGreaterThanOrEqual(17)
    expect(s).toBeLessThanOrEqual(32)
    expect(l).toBeGreaterThanOrEqual(16)
    expect(l).toBeLessThanOrEqual(38)
  })

  it('returns null for grayscale and empty input', () => {
    expect(pickClothHue(many(200, () => ({ r: 128, g: 128, b: 128 })))).toBeNull()
    expect(pickClothHue([])).toBeNull()
  })

  it('rejects a small logo, matches a substantial one', () => {
    const white = { r: 250, g: 250, b: 250 }
    const red = hsl(2, 0.75, 0.4)
    const logo8 = [...many(115, () => white), ...many(10, () => red)]
    expect(pickClothHue(logo8)).toBeNull()          // under the 10% share
    const logo15 = [...many(100, () => white), ...many(18, () => red)]
    const { h } = parse(pickClothHue(logo15)!)
    expect(h <= 5 || h >= 357).toBe(true)
  })

  it('matches a full dark navy cover', () => {
    const { h } = parse(pickClothHue(many(400, () => hsl(220, 0.55, 0.22)))!)
    expect(Math.abs(h - 220)).toBeLessThanOrEqual(2)
  })

  it('merges a red straddling the hue wrap', () => {
    const samples = [
      ...many(180, () => hsl(350, 0.6, 0.35)),
      ...many(180, () => hsl(5, 0.6, 0.35)),
    ]
    const { h } = parse(pickClothHue(samples)!)
    expect(h <= 8 || h >= 348).toBe(true)
  })

  it('clamps neon saturation and lightness', () => {
    const { s, l } = parse(pickClothHue(many(300, () => hsl(120, 1.0, 0.6)))!)
    expect(s).toBeLessThanOrEqual(32)
    expect(l).toBeLessThanOrEqual(38)
  })

  it('rejects covers below the chromatic vote gate, floors pastels', () => {
    expect(pickClothHue(many(300, () => hsl(40, 0.15, 0.35)))).toBeNull()
    const { s } = parse(pickClothHue(many(300, () => hsl(40, 0.25, 0.35)))!)
    expect(s).toBeGreaterThanOrEqual(17)
  })
})
