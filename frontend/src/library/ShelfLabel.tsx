import { useEffect, useState } from 'react'
import type { BookSummary } from '../types'
import { useLibraryStore } from '../stores/libraryStore'
import { llmStatus, rechunkBook } from '../api/client'
import type { LlmStatus } from '../api/client'

interface ShelfLabelProps {
  hero?: BookSummary
  presented?: BookSummary
  /** open to read — the caller resolves the flight origin (present-then-fly
   *  for the hero, the presented cover for Read) */
  onOpen: (book: BookSummary) => void
  /** browse the shelf from the stage's arrows */
  onNavigate: (delta: number) => void
  onClear: () => void
}

/**
 * The paper stage pinned below the shelf, in Grokipedia's shape: browse
 * arrows, kicker + serif title + meta line, and an ink CTA on the right.
 * Continue-reading hero when idle; the presented book's details + actions
 * when one is pulled off the shelf. Keyed remount re-runs band-rise.
 */
export default function ShelfLabel({
  hero,
  presented,
  onOpen,
  onNavigate,
  onClear,
}: ShelfLabelProps) {
  const remove = useLibraryStore((s) => s.remove)
  const refresh = useLibraryStore((s) => s.refresh)
  const [rechucking, setRechucking] = useState(false)
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  useEffect(() => {
    let live = true
    llmStatus()
      .then((s) => live && setLlm(s))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const gen = presented?.generation
  const generating = presented && gen != null && gen.ready < gen.total
  const warnCount = presented?.warnings?.length ?? 0
  const book = presented ?? hero

  return (
    <div
      className="shelf-label"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && presented) onClear()
      }}
    >
      <div
        className="shelf-label-row"
        key={presented?.id ?? hero?.id ?? 'idle'}
      >
        {presented ? (
          <>
            <div className="shelf-nav-cluster" aria-label="Browse the shelf">
              <button
                className="shelf-nav"
                aria-label="Previous book"
                onClick={() => onNavigate(-1)}
              >
                ‹
              </button>
              <button
                className="shelf-nav"
                aria-label="Next book"
                onClick={() => onNavigate(1)}
              >
                ›
              </button>
            </div>
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
                  <p
                    className="mt-1 text-xs"
                    style={{ color: 'var(--muted)' }}
                  >
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
            <div className="flex shrink-0 items-center gap-2">
              <button
                className="btn btn-ghost btn-sm"
                title={
                  rechucking
                    ? 'Re-chunking…'
                    : llm?.configured
                      ? `Re-break narration with the AI planner (${llm.model}; matching audio is kept)`
                      : 'Re-break narration at sentence boundaries (keeps existing audio)'
                }
                disabled={rechucking}
                onClick={async () => {
                  setRechucking(true)
                  try {
                    const r = await rechunkBook(
                      presented.id,
                      llm?.configured ? 'llm' : 'heuristic',
                    )
                    const by = llm?.configured
                      ? `the ${llm.model} planner`
                      : 'sentence boundaries'
                    window.alert(
                      `Re-broke ${r.sections_total} sections at ${by}. ` +
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
                  if (
                    window.confirm(`Remove "${presented.title}" from library?`)
                  ) {
                    onClear()
                    void remove(presented.id)
                  }
                }}
              >
                ✕
              </button>
              <button
                className="shelf-label-cta"
                onClick={() => onOpen(presented)}
              >
                Read <span aria-hidden="true">→</span>
              </button>
            </div>
          </>
        ) : book ? (
          <>
            <div className="shelf-label-copy min-w-0 flex-1">
              <p className="kicker" style={{ color: 'var(--accent)' }}>
                Continue reading
              </p>
              <h2
                className="shelf-label-title"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {book.title}
              </h2>
              <p className="shelf-label-meta">
                {book.author || 'Unknown'} · {Math.round(book.percent ?? 0)}%
                read
              </p>
            </div>
            <button
              className="shelf-label-cta shrink-0"
              onClick={() => onOpen(book)}
            >
              Continue <span aria-hidden="true">→</span>
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
      {presented && (
        <p className="kicker shelf-hint">Select again to read · ← → browse · Esc re-shelve</p>
      )}
    </div>
  )
}
