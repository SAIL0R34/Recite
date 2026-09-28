// Book-open flight overlay: the clicked card's cover flies from its
// library position to the center of the screen and dissolves, while the
// reader opens calmly beneath (positioned single paint). Pointer-events
// none throughout; gated at capture time by pageAnimations + reduced
// motion, so this never mounts for users who opted out.

import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { coverUrl } from './api/client'
import { useFlightStore } from './stores/flightStore'
import type { FlightPayload } from './stores/flightStore'

export default function BookTransition() {
  const pending = useFlightStore((s) => s.pending)
  const clear = useFlightStore((s) => s.clear)
  const { pathname } = useLocation()
  const [flight, setFlight] = useState<FlightPayload | null>(null)
  const consumedRef = useRef(0)

  useEffect(() => {
    if (!pending) return
    if (pathname !== `/book/${encodeURIComponent(pending.bookId)}`) {
      clear() // navigation went elsewhere — stale payload
      return
    }
    if (consumedRef.current === pending.nonce) return // StrictMode re-run
    consumedRef.current = pending.nonce
    setFlight(pending) // kept locally for the animation duration
    clear() // one-shot: the store never holds it again
  }, [pending, pathname, clear])

  if (!flight) return null
  return <Flight key={flight.nonce} p={flight} onDone={() => setFlight(null)} />
}

function Flight({ p, onDone }: { p: FlightPayload; onDone: () => void }) {
  const [phase, setPhase] = useState<'start' | 'fly' | 'fade'>('start')
  const [imgOk, setImgOk] = useState(true)

  useEffect(() => {
    // double rAF: frame 1 paints at the captured rect, then the transition
    const raf2 = requestAnimationFrame(() =>
      requestAnimationFrame(() => setPhase('fly')),
    )
    // fallbacks — transitionend never fires in a backgrounded tab
    const tFade = setTimeout(() => setPhase('fade'), 560)
    const tDone = setTimeout(onDone, 840)
    return () => {
      cancelAnimationFrame(raf2)
      clearTimeout(tFade)
      clearTimeout(tDone)
    }
  }, [onDone])

  let transform: string | undefined
  if (phase !== 'start') {
    const vw = window.innerWidth
    const vh = window.innerHeight
    // at-rest "book" size: 2:3 box, clamped by half the viewport height
    const targetW = Math.min(360, vw * 0.45, (vh * 0.5) / 1.5)
    const s = targetW / p.from.w
    const dx = vw / 2 - (p.from.x + p.from.w / 2)
    const dy = vh / 2 - (p.from.y + p.from.h / 2)
    transform = `translate(${dx}px, ${dy}px) scale(${s})`
  }

  return (
    <div
      className="book-flight-cover rounded-md"
      style={{
        left: p.from.x,
        top: p.from.y,
        width: p.from.w,
        height: p.from.h,
        transform,
        opacity: phase === 'fade' ? 0 : 1,
      }}
      onTransitionEnd={(e) => {
        if (e.propertyName === 'transform' && phase === 'fly') setPhase('fade')
        else if (e.propertyName === 'opacity' && phase === 'fade') onDone()
      }}
    >
      {imgOk && p.kind === 'img' ? (
        <img
          src={coverUrl(p.bookId)}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setImgOk(false)}
        />
      ) : (
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-1 p-3 text-center"
          style={{ background: 'var(--surface-2)' }}
        >
          <span className="line-clamp-3 font-semibold leading-tight">{p.title}</span>
          <span className="line-clamp-1 text-xs" style={{ color: 'var(--muted)' }}>
            {p.author || ''}
          </span>
        </div>
      )}
    </div>
  )
}
