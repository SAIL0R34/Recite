import { useEffect } from 'react'
import type { CSSProperties } from 'react'
import { usePraiseStore } from './stores/praiseStore'
import type { PraiseBurst } from './stores/praiseStore'
import { animOK } from './motion'

/**
 * Confetti overlay for reading celebrations — paper, gilt and crimson bits
 * in the theme palette, festive but still editorial. The book kicks them up
 * as it lifts off. Fixed-positioned at App level so a burst outlives the
 * route change when the flight is off and navigation is instant. One slow
 * burst per celebration (no repeat volleys); longer sittings throw wider
 * and thicker. Every burst renders as its own layer (see praiseStore) so
 * overlapping celebrations never replace each other.
 */

const LIFE_MS = 4200

/** Burst from the top-center of an element (a presented book's cover). */
export function praise(el: Element | null | undefined, intensity = 1) {
  if (!el || !animOK()) return
  const r = el.getBoundingClientRect()
  praiseAt(r.left + r.width / 2, r.top + 14, intensity)
}

export function praiseAt(x: number, y: number, intensity = 1) {
  if (!animOK()) return
  usePraiseStore.getState().burst(x, y, intensity)
}

/** Deterministic per-index pseudo-random in [0, 1) — stable across renders. */
function rnd(i: number, salt: number): number {
  const v = Math.sin((i + 1) * (salt + 12.9898)) * 43758.5453
  return v - Math.floor(v)
}

const SHAPES = ['sq', 'ribbon', 'sq', 'dot', 'sq', 'ribbon'] as const

/**
 * The horizontal half of the rig: the carrier drifts sideways (fan angle ×
 * distance, plus a little wind) at constant speed, and owns the fade.
 */
function carrierVars(i: number, intensity: number): CSSProperties {
  const ang = (rnd(i, 1) - 0.5) * Math.PI * 1.6
  const dist = (70 + rnd(i, 2) * 130) * intensity
  return {
    '--dx': `${Math.cos(ang) * dist}px`,
    '--wind': `${(rnd(i, 9) - 0.5) * 46}px`,
    '--dur': `${Math.round(2800 + rnd(i, 5) * 800)}ms`,
    '--del': `${Math.round(rnd(i, 6) * 380)}ms`,
  } as CSSProperties
}

/**
 * The vertical half: the bit pops, decelerates to its apex and accelerates
 * into the fall (per-keyframe easing in praise-rise), tumbling throughout.
 */
function bitVars(i: number, intensity: number): CSSProperties {
  const ang = (rnd(i, 1) - 0.5) * Math.PI * 1.6
  const dist = (70 + rnd(i, 2) * 130) * intensity
  return {
    '--dy': `${Math.sin(ang) * dist * 0.45 - 110 - rnd(i, 7) * 80}px`,
    '--fall': `${Math.round((190 + rnd(i, 8) * 180) * Math.min(intensity, 1.6))}px`,
    '--r1': `${Math.round((rnd(i, 3) - 0.5) * 90)}deg`,
    '--r2': `${Math.round((rnd(i, 4) - 0.5) * 1440)}deg`,
    '--dur': `${Math.round(2800 + rnd(i, 5) * 800)}ms`,
    '--del': `${Math.round(rnd(i, 6) * 380)}ms`,
  } as CSSProperties
}

export default function PraiseConfetti() {
  const bursts = usePraiseStore((s) => s.bursts)
  return (
    <>
      {bursts.map((b) => (
        <BurstLayer key={b.id} burst={b} />
      ))}
    </>
  )
}

function BurstLayer({ burst }: { burst: PraiseBurst }) {
  const prune = usePraiseStore((s) => s.prune)
  useEffect(() => {
    const t = setTimeout(() => prune(burst.id), LIFE_MS)
    return () => clearTimeout(t)
  }, [burst.id, prune])
  const bits = Math.round(Math.min(120, 44 * burst.intensity))
  return (
    <div
      className="praise"
      style={{ left: burst.x, top: burst.y }}
      aria-hidden="true"
    >
      {Array.from({ length: bits }, (_, i) => (
        <span key={i} className="praise-carrier" style={carrierVars(i, burst.intensity)}>
          <span
            className={`praise-bit ${SHAPES[i % 6]}`}
            style={bitVars(i, burst.intensity)}
          />
        </span>
      ))}
    </div>
  )
}
