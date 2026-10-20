import { useRef, useState } from 'react'
import type { BookSummary } from '../types'
import { useLibraryStore } from '../stores/libraryStore'
import { coverUrl, rechunkBook } from '../api/client'

interface ShelfLabelProps {
  hero?: BookSummary
  presented?: BookSummary
  /** el is the flight origin when the caller has one (hero thumb); the
   *  presented book's shelf face is resolved by the caller when null */
  onOpen: (book: BookSummary, el: Element | null) => void
  onClear: () => void
}

/** Small cover thumb with the same 404 → typographic treatment. */
function Thumb({ book }: { book: BookSummary }) {
  const [ok, setOk] = useState(true)
  return ok ? (
    <img
      src={coverUrl(book.id)}
      alt=""
      loading="lazy"
      onError={() => setOk(false)}
      className="h-[72px] w-12 rounded-md object-cover"
      style={{ boxShadow: 'var(--shadow)' }}
    />
  ) : (
    <div
      className="flex h-[72px] w-12 items-center justify-center rounded-md p-1 text-center"
      style={{ background: 'var(--surface-2)' }}
    >
      <span className="line-clamp-3 text-[9px] font-semibold leading-tight">
        {book.title}
      </span>
    </div>
  )
}

/**
 * The paper stage pinned to the bottom of the library: the continue-reading
 * hero when idle, the presented book's details + actions when a book is
 * pulled off the shelf. Keyed remount of the copy block re-runs band-rise.
 */
export default function ShelfLabel({
  hero,
  presented,
  onOpen,
  onClear,
}: ShelfLabelProps) {
  const remove = useLibraryStore((s) => s.remove)
  const refresh = useLibraryStore((s) => s.refresh)
  const [rechucking, setRechucking] = useState(false)
  const heroThumbRef = useRef<HTMLDivElement>(null)

  const gen = presented?.generation
  const generating = presented && gen != null && gen.ready < gen.total
  const warnCount = presented?.warnings?.length ?? 0

  return (
    <div
      className="shelf-label"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && presented) onClear()
      }}
    >
      <div
        className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3"
        key={presented?.id ?? hero?.id ?? 'idle'}
      >
        {presented ? (
          <>
            <div
              className="shelf-label-copy min-w-0 flex-1"
              role="status"
              aria-live="polite"
            >
              <p className="kicker">From the shelf</p>
              <h2
                className="shelf-label-title"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {presented.title}
              </h2>
              <p className="shelf-label-meta">
                {presented.author || 'Unknown'} · {presented.format} ·{' '}
                {presented.status} · {Math.round(presented.percent ?? 0)}% read
                {warnCount > 0 && (
                  <span
                    className="shelf-label-warn"
                    title={presented.warnings.join('; ')}
                  >
                    ⚠ {warnCount}
                  </span>
                )}
              </p>
              {generating && gen && (
                <div className="mt-1.5">
                  <div
                    className="h-1.5 overflow-hidden rounded-full"
                    style={{ background: 'var(--surface-2)' }}
                    role="progressbar"
                    aria-label="narration progress"
                    aria-valuemin={0}
                    aria-valuemax={gen.total}
                    aria-valuenow={gen.ready}
                  >
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{
                        width: `${gen.total ? (gen.ready / gen.total) * 100 : 0}%`,
                        background: 'var(--accent)',
                      }}
                    />
                  </div>
                  <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                    Generating narration — {gen.ready}/{gen.total} parts
                    {gen.failed > 0 && (
                      <span style={{ color: 'var(--danger)' }}>
                        {' '}
                        · {gen.failed} failed (open the book to retry)
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-ghost btn-sm"
                  title={
                    rechucking
                      ? 'Re-chunking…'
                      : 'Re-break narration at sentence boundaries (keeps existing audio)'
                  }
                  disabled={rechucking}
                  onClick={async () => {
                    setRechucking(true)
                    try {
                      const r = await rechunkBook(presented.id)
                      window.alert(
                        `Re-broke ${r.sections_total} sections at sentence boundaries. ` +
                          (r.sections_reset
                            ? `${r.sections_reset} section(s) need new audio and are regenerating now.`
                            : 'All audio was reused — nothing to regenerate.'),
                      )
                    } catch (err) {
                      window.alert(`Re-chunk failed: ${(err as Error).message}`)
                    } finally {
                      setRechucking(false)
                      void refresh()
                    }
                  }}
                >
                  {rechucking ? '⏳' : '↺'}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  title="Remove from library"
                  onClick={() => {
                    if (window.confirm(`Remove "${presented.title}" from library?`)) {
                      onClear()
                      void remove(presented.id)
                    }
                  }}
                >
                  ✕
                </button>
                <button
                  className="btn btn-accent"
                  onClick={() => onOpen(presented, null)}
                >
                  Read
                </button>
              </div>
              <p className="kicker hidden md:block">
                Select again to read · ← → browse · Esc re-shelve
              </p>
            </div>
          </>
        ) : hero ? (
          <>
            <div ref={heroThumbRef} className="shrink-0">
              <Thumb book={hero} />
            </div>
            <div className="shelf-label-copy min-w-0 flex-1">
              <p className="kicker" style={{ color: 'var(--accent)' }}>
                Continue reading
              </p>
              <h2
                className="shelf-label-title"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {hero.title}
              </h2>
              <p className="shelf-label-meta">
                {hero.author || 'Unknown'} · {Math.round(hero.percent ?? 0)}% read
              </p>
            </div>
            <button
              className="btn btn-accent shrink-0"
              onClick={() => onOpen(hero, heroThumbRef.current)}
            >
              Continue →
            </button>
          </>
        ) : (
          <div className="shelf-label-copy flex-1">
            <p className="kicker">The bookcase</p>
            <p className="shelf-label-meta">
              Select a book to present it, then select again to read.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
