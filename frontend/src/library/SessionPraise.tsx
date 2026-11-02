import { useEffect, useRef } from 'react'
import type { EndedSession } from '../readingSession'
import { formatDuration } from '../readingSession'
import { praiseAt } from '../PraiseConfetti'

interface SessionPraiseProps {
  session: EndedSession
  onDone: () => void
}

/**
 * The close celebration: returning from a real sitting lands on this paper
 * card — "You read for 1h 12m." — with a single slow confetti burst behind
 * it (the card paints above the confetti layer). The duration is active
 * narration time, not wall-clock. Dismiss on click, Escape, or six quiet
 * seconds.
 */
export default function SessionPraise({ session, onDone }: SessionPraiseProps) {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    // 45 min of reading adds a full step of spread, capped at triple
    const intensity = Math.min(3, 1.1 + session.ms / (45 * 60_000))
    timers.push(
      setTimeout(() => {
        const el = cardRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        praiseAt(r.left + r.width / 2, r.top + 18, intensity)
      }, 360),
    )
    timers.push(setTimeout(onDone, 6000))
    return () => timers.forEach(clearTimeout)
  }, [session, onDone])

  return (
    <div
      className="session-praise"
      role="dialog"
      aria-label="Reading session complete"
      onClick={onDone}
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
    >
      <div ref={cardRef} className="session-praise-card">
        <p className="kicker" style={{ color: 'var(--accent)' }}>
          Well read
        </p>
        <h2
          className="session-praise-duration"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          You read for {formatDuration(session.ms)}.
        </h2>
        <p className="session-praise-asterism" aria-hidden="true">
          ⁂
        </p>
        <p className="session-praise-book">{session.title}</p>
        <p className="kicker mt-3">Click anywhere to continue</p>
      </div>
    </div>
  )
}
