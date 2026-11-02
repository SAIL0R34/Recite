import { useEffect, useRef } from 'react'
import { formatDuration } from '../readingSession'
import { praiseAt } from '../PraiseConfetti'

/** The pause card: a compact, non-blocking sibling of the session
 *  celebration — "You've been reading for 23m." with one gentle confetti
 *  pop behind it. Dismiss on click or five quiet seconds; resuming
 *  playback dismisses it instantly (the parent clears us). */
export default function PausePraise({
  ms,
  title,
  onDismiss,
}: {
  ms: number
  title: string
  onDismiss: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    // gentler than the session card's curve (min(3, 1.1 + ms/45min))
    const intensity = Math.min(2, 0.7 + ms / (30 * 60_000))
    timers.push(
      setTimeout(() => {
        const el = cardRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        praiseAt(r.left + r.width / 2, r.top + 18, intensity)
      }, 360),
    )
    timers.push(setTimeout(onDismiss, 5000))
    return () => timers.forEach(clearTimeout)
  }, [ms, onDismiss])

  return (
    <div
      className="pause-praise"
      role="status"
      aria-live="polite"
      onClick={onDismiss}
    >
      <div ref={cardRef} className="pause-praise-card">
        <p className="kicker" style={{ color: 'var(--accent)' }}>
          Paused
        </p>
        <p
          className="pause-praise-duration"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          You've been reading for {formatDuration(ms)}.
        </p>
        <p className="session-praise-asterism" aria-hidden="true">
          ⁂
        </p>
        <p className="pause-praise-book">{title}</p>
      </div>
    </div>
  )
}
