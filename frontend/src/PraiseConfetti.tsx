import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { usePraiseStore } from './stores/praiseStore'
import { animOK } from './motion'

/**
 * Confetti overlay for open-to-read celebrations — paper bits in the theme
 * palette, not rainbow: the book kicks them up as it lifts off. Fixed-
 * positioned at App level so the burst outlives the route change when the
 * flight is off and navigation is instant.
 */

/** Burst from the top-center of an element (the presented book's face). */
export function praise(el: Element | null | undefined, intensity = 1) {
  if (!el || !animOK()) return
  const r = el.getBoundingClientRect()
  usePraiseStore.getState().burst(r.left + r.width / 2, r.top + 12, intensity)
}

/** Deterministic per-index pseudo-random in [0, 1) — stable across renders. */
function rnd(i: number, salt: number): number {
  const v = Math.sin((i + 1) * (salt + 12.9898)) * 43758.5453
  return v - Math.floor(v)
}

function bitVars(i: number, intensity: number): CSSProperties {
  const ang = (rnd(i, 1) - 0.5) * Math.PI * 1.5 // fan, biased outward
  const dist = (46 + rnd(i, 2) * 78) * intensity
  return {
    '--dx': `${Math.cos(ang) * dist}px`,
    '--dy': `${Math.sin(ang) * dist * 0.55 - 64}px`,
    '--r1': `${Math.round((rnd(i, 3) - 0.5) * 540)}deg`,
    '--r2': `${Math.round((rnd(i, 4) - 0.5) * 900)}deg`,
    '--dur': `${Math.round(760 + rnd(i, 5) * 420)}ms`,
    '--del': `${Math.round(rnd(i, 6) * 90)}ms`,
  } as CSSProperties
}

const BITS = 18
const LIFE_MS = 1400

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
  return (
    <div
      className="praise"
      style={{ left: x, top: y }}
      aria-hidden="true"
      key={live}
    >
      {Array.from({ length: BITS }, (_, i) => (
        <span
          key={i}
          className="praise-bit"
          style={bitVars(i, intensity)}
        />
      ))}
    </div>
  )
}
