import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { usePraiseStore } from './stores/praiseStore'
import { animOK } from './motion'

/**
 * Confetti overlay for reading celebrations — paper, gilt and crimson bits
 * in the theme palette, festive but still editorial. The book kicks them up
 * as it lifts off. Fixed-positioned at App level so a burst outlives the
 * route change when the flight is off and navigation is instant. Each
 * praise() fires two volleys; longer sittings throw wider and thicker.
 */

const LIFE_MS = 2600

/** Burst from the top-center of an element (a presented book's cover). */
export function praise(el: Element | null | undefined, intensity = 1) {
  if (!el || !animOK()) return
  const r = el.getBoundingClientRect()
  praiseAt(r.left + r.width / 2, r.top + 14, intensity)
}

export function praiseAt(x: number, y: number, intensity = 1) {
  if (!animOK()) return
  const burst = usePraiseStore.getState().burst
  burst(x, y, intensity)
  // second volley, jittered — the "again!" of a proper celebration
  setTimeout(() => burst(x + (Math.random() - 0.5) * 60, y + 8, intensity), 240)
}

/** Deterministic per-index pseudo-random in [0, 1) — stable across renders. */
function rnd(i: number, salt: number): number {
  const v = Math.sin((i + 1) * (salt + 12.9898)) * 43758.5453
  return v - Math.floor(v)
}

const SHAPES = ['sq', 'ribbon', 'sq', 'dot', 'sq', 'ribbon'] as const

function bitVars(i: number, intensity: number): CSSProperties {
  // a tight, tall fountain: fan out, rise hard, then let gravity have it
  const ang = (rnd(i, 1) - 0.5) * Math.PI * 1.6
  const dist = (70 + rnd(i, 2) * 130) * intensity
  return {
    '--dx': `${Math.cos(ang) * dist}px`,
    '--dy': `${Math.sin(ang) * dist * 0.45 - 120 - rnd(i, 7) * 90}px`,
    '--fall': `${160 + rnd(i, 8) * 140}px`,
    '--r1': `${Math.round((rnd(i, 3) - 0.5) * 720)}deg`,
    '--r2': `${Math.round((rnd(i, 4) - 0.5) * 1440)}deg`,
    '--dur': `${Math.round(1600 + rnd(i, 5) * 900)}ms`,
    '--del': `${Math.round(rnd(i, 6) * 200)}ms`,
  } as CSSProperties
}

export default function PraiseConfetti() {
  const nonce = usePraiseStore((s) => s.nonce)
  const x = usePraiseStore((s) => s.x)
  const y = usePraiseStore((s) => s.y)
  const intensity = usePraiseStore((s) => s.intensity)
  const [live, setLive] = useState(0)

  useEffect(() => {
    if (nonce === 0) return
    setLive(nonce)
    const t = setTimeout(() => setLive(0), LIFE_MS)
    return () => clearTimeout(t)
  }, [nonce])

  if (!live) return null
  const bits = Math.round(Math.min(120, 44 * intensity))
  return (
    <div className="praise" style={{ left: x, top: y }} aria-hidden="true">
      {Array.from({ length: bits }, (_, i) => (
        <span key={i} className={`praise-bit ${SHAPES[i % 6]}`} style={bitVars(i, intensity)} />
      ))}
    </div>
  )
}
