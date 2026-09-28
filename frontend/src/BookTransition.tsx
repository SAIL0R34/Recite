// Book-open flight overlay — the full choreography:
//   lift  (200ms)  cover peels off its card, scrim in, library recedes
//   fly   (420ms)  flight to center with a slight overshoot, shadow grows
//   open  (280ms)  the right half hinges open on the spine, page revealed
//   fade  (200ms)  book and scrim dissolve into the positioned reader
// The overlay performs the navigation itself at the lift→fly handoff, so
// the library is still on screen (receding) while the cover lifts. All
// motion is transform/opacity/box-shadow; gated at capture by
// pageAnimations + reduced motion, so this never mounts for users who
// opted out. Timers drive the phases (transitionend never fires in
// backgrounded tabs).

import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { coverUrl } from './api/client'
import { useFlightStore } from './stores/flightStore'
import type { FlightPayload } from './stores/flightStore'

const LIFT_MS = 200
const FLY_MS = 420
const OPEN_MS = 280
const FADE_MS = 200

type Phase = 'lift' | 'fly' | 'open' | 'fade'

export default function BookTransition() {
  const pending = useFlightStore((s) => s.pending)
  const clear = useFlightStore((s) => s.clear)
  const [flight, setFlight] = useState<FlightPayload | null>(null)
  const consumedRef = useRef(0)

  useEffect(() => {
    if (!pending) return
    if (consumedRef.current === pending.nonce) return // StrictMode re-run
    consumedRef.current = pending.nonce
    setFlight(pending) // kept locally for the animation duration
    clear() // one-shot: the store never holds it again
  }, [pending, clear])

  if (!flight) return null
  return (
    <Flight
      key={flight.nonce}
      p={flight}
      onDone={() => {
        setFlight(null)
        useFlightStore.getState().endFlight()
      }}
    />
  )
}

function Flight({ p, onDone }: { p: FlightPayload; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>('lift')
  const [imgOk, setImgOk] = useState(true)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const navigatedRef = useRef(false)

  // phase advance by timer; navigation happens at the lift→fly handoff
  useEffect(() => {
    if (phase === 'lift') {
      const t = setTimeout(() => {
        const target = `/book/${encodeURIComponent(p.bookId)}`
        // if the user fled the library mid-lift (e.g. pressed Back), don't
        // fight them — dissolve where we are instead of navigating
        const fled = pathname !== '/' && pathname !== target
        if (!navigatedRef.current) {
          navigatedRef.current = true
          if (!fled) navigate(target)
        }
        setPhase(fled ? 'fade' : 'fly')
      }, LIFT_MS)
      return () => clearTimeout(t)
    }
    if (phase === 'fly') {
      const t = setTimeout(() => setPhase('open'), FLY_MS)
      return () => clearTimeout(t)
    }
    if (phase === 'open') {
      const t = setTimeout(() => setPhase('fade'), OPEN_MS)
      return () => clearTimeout(t)
    }
    const t = setTimeout(onDone, FADE_MS)
    return () => clearTimeout(t)
  }, [phase, navigate, p.bookId, onDone, pathname])

  // fly/open target: centered 2:3 box, clamped by half the viewport height
  let transform: string
  let transition: string
  let shadow: string
  if (phase === 'lift') {
    transform = 'translateY(-8px) scale(1.05)'
    transition = `transform ${LIFT_MS}ms cubic-bezier(0.22,0.61,0.36,1), box-shadow ${LIFT_MS}ms ease-out, opacity ${FADE_MS}ms ease-out`
    shadow = '0 14px 32px rgba(0,0,0,0.28)'
  } else {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const targetW = Math.min(360, vw * 0.45, (vh * 0.5) / 1.5)
    const s = targetW / p.from.w
    const dx = vw / 2 - (p.from.x + p.from.w / 2)
    const dy = vh / 2 - (p.from.y + p.from.h / 2)
    transform = `translate(${dx}px, ${dy}px) scale(${s})`
    // the 1.18 gives a small physical overshoot before settling
    transition = `transform ${FLY_MS}ms cubic-bezier(0.34,1.18,0.42,1), box-shadow ${FLY_MS}ms ease-out, opacity ${FADE_MS}ms ease-out`
    shadow =
      phase === 'open'
        ? '0 18px 44px rgba(0,0,0,0.30)'
        : '0 30px 70px rgba(0,0,0,0.38)'
  }

  const fading = phase === 'fade'
  const scrimOn = phase !== 'fade'
  const flapOpen = phase === 'open' || phase === 'fade'

  const hasImg = imgOk && p.kind === 'img'

  return (
    <>
      <div
        className="book-flight-scrim"
        style={{ opacity: scrimOn ? 1 : 0 }}
      />
      <div
        className="book-flight-cover"
        style={{
          left: p.from.x,
          top: p.from.y,
          width: p.from.w,
          height: p.from.h,
          transform,
          boxShadow: shadow,
          transition,
          opacity: fading ? 0 : 1,
        }}
      >
        {hasImg ? (
          <>
            {/* first page revealed as the cover opens (bottom layer) */}
            <div className="book-flight-underside" />
            {/* the LEFT half of the cover, static across the spine */}
            <div className="book-flight-left">
              <CoverVisual p={p} imgOk onImgError={() => setImgOk(false)} />
            </div>
            {/* the right half of the cover, hinging on the spine */}
            <div className={flapOpen ? 'book-flight-flap is-open' : 'book-flight-flap'}>
              <img
                src={coverUrl(p.bookId)}
                alt=""
                className="book-flight-flap-img"
              />
            </div>
            {/* title rides the cover, dissolving as the book opens */}
            <div className={flapOpen ? 'book-flight-title is-hidden' : 'book-flight-title'}>
              <span className="book-flight-title-name line-clamp-2">{p.title}</span>
              {p.author && (
                <span className="book-flight-title-author line-clamp-1">{p.author}</span>
              )}
            </div>
          </>
        ) : (
          /* coverless book: the typographic card flies whole, title centered */
          <CoverVisual p={p} imgOk={false} onImgError={() => setImgOk(false)} />
        )}
        {/* spine shading down the left edge — reads as a bound book */}
        <div className="book-flight-spine" />
      </div>
    </>
  )
}

function CoverVisual({
  p,
  imgOk,
  onImgError,
}: {
  p: FlightPayload
  imgOk: boolean
  onImgError: () => void
}) {
  if (imgOk && p.kind === 'img')
    return (
      <img
        src={coverUrl(p.bookId)}
        alt=""
        className="h-full w-full object-cover"
        onError={onImgError}
      />
    )
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-1 p-3 text-center"
      style={{ background: 'var(--surface-2)' }}
    >
      <span className="line-clamp-3 font-semibold leading-tight">{p.title}</span>
      <span className="line-clamp-1 text-xs" style={{ color: 'var(--muted)' }}>
        {p.author || ''}
      </span>
    </div>
  )
}
