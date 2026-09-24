import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BookSummary } from '../types'
import { useLibraryStore } from '../stores/libraryStore'
import { coverUrl, rechunkBook } from '../api/client'

/** Cover thumbnail written at ingest; typographic card when absent (404). */
export function BookCover({ book }: { book: BookSummary }) {
  const [ok, setOk] = useState(true)
  return ok ? (
    <img
      src={coverUrl(book.id)}
      alt=""
      loading="lazy"
      onError={() => setOk(false)}
      className="aspect-[2/3] w-full rounded-md object-cover"
    />
  ) : (
    <div
      className="flex aspect-[2/3] w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-md p-3 text-center"
      style={{ background: 'var(--surface-2)' }}
    >
      <span className="line-clamp-3 font-semibold leading-tight">{book.title}</span>
      <span className="line-clamp-1 text-xs" style={{ color: 'var(--muted)' }}>
        {book.author || ''}
      </span>
    </div>
  )
}

function Ring({ percent }: { percent: number }) {
  const r = 20
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, percent ?? 0))
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden>
      <circle
        cx="26"
        cy="26"
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth="4"
      />
      <circle
        cx="26"
        cy="26"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p / 100)}
        transform="rotate(-90 26 26)"
      />
      <text
        x="26"
        y="30"
        textAnchor="middle"
        fontSize="10"
        fill="var(--muted)"
      >
        {Math.round(p)}%
      </text>
    </svg>
  )
}

export default function BookCard({ book }: { book: BookSummary }) {
  const navigate = useNavigate()
  const remove = useLibraryStore((s) => s.remove)
  const refresh = useLibraryStore((s) => s.refresh)
  const [rechucking, setRechucking] = useState(false)
  const warn = (book.warnings?.length ?? 0) > 0

  return (
    <div
      className="card flex cursor-pointer flex-col gap-3 p-4 transition-shadow hover:shadow-lg"
      onClick={() => navigate(`/book/${encodeURIComponent(book.id)}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) =>
        e.key === 'Enter' && navigate(`/book/${encodeURIComponent(book.id)}`)
      }
    >
      <BookCover book={book} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium leading-snug">{book.title}</h3>
          <p className="truncate text-sm" style={{ color: 'var(--muted)' }}>
            {book.author || 'Unknown'}
          </p>
        </div>
        <Ring percent={book.percent ?? 0} />
      </div>
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
        <span
          className="rounded px-1.5 py-0.5 uppercase"
          style={{ background: 'var(--surface-2)' }}
        >
          {book.format}
        </span>
        <span>{book.status}</span>
        {warn && (
          <span
            title={book.warnings.join('; ')}
            className="rounded px-1.5 py-0.5"
            style={{ background: 'var(--surface-2)' }}
          >
            ⚠ {book.warnings.length}
          </span>
        )}
        <button
          className="btn btn-ghost btn-sm ml-auto"
          title={rechucking
            ? 'Re-chunking\u2026'
            : 'Re-break narration at sentence boundaries (keeps existing audio)'}
          disabled={rechucking}
          onClick={async (e) => {
            e.stopPropagation()
            setRechucking(true)
            try {
              const r = await rechunkBook(book.id)
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
          onClick={(e) => {
            e.stopPropagation()
            if (window.confirm(`Remove "${book.title}" from library?`))
              void remove(book.id)
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
