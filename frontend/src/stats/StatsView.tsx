import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getStats } from '../api/client'
import type { Stats } from '../api/client'
import { formatDuration } from '../readingSession'

/** "42m" / "1h 05m" from seconds. */
const dur = (s: number) => formatDuration((s || 0) * 1000)

const dayLabel = (iso: string) => {
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats-tile">
      <p className="kicker">{label}</p>
      <p
        className="stats-tile-value"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {value}
      </p>
    </div>
  )
}

/**
 * Reading analytics, in the house editorial voice: headline stat tiles, a
 * single-hue daily bar series, and per-book / per-format / per-state time
 * splits. Books carry no genre metadata, so "state" (reading / finished /
 * unread) is the closest category on offer.
 */
export default function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getStats()
      .then(setStats)
      .catch((e) => setError((e as Error).message))
  }, [])

  const maxDay = useMemo(
    () => Math.max(1, ...(stats?.daily.map((d) => d.seconds) ?? [1])),
    [stats],
  )
  const maxBook = useMemo(
    () => Math.max(1, ...(stats?.per_book.map((b) => b.sec) ?? [1])),
    [stats],
  )

  if (error)
    return (
      <div className="recite-scroll h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl p-6" style={{ color: 'var(--muted)' }}>
          Backend unreachable: {error}
        </div>
      </div>
    )
  if (!stats) return null

  return (
    <div className="recite-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 pb-16 pt-8">
        <p className="kicker mb-1">
          <Link to="/" style={{ color: 'var(--muted)' }}>
            The bookcase
          </Link>{' '}
          · reading analytics
        </p>
        <h1
          className="mb-8 text-[32px] font-medium leading-none tracking-tight"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          The Ledger
        </h1>

        <div className="stats-tiles">
          <Tile label="Time read" value={dur(stats.total_s)} />
          <Tile label="Day streak" value={`${stats.streak_days}`} />
          <Tile label="Sittings" value={`${stats.sessions}`} />
          <Tile label="Books read" value={`${stats.books_read}`} />
        </div>

        {stats.total_s === 0 ? (
          <div className="card mt-8 p-10 text-center" style={{ color: 'var(--muted)' }}>
            No sittings recorded yet. Read a book and come back — every
            sitting lands here.
          </div>
        ) : (
          <>
            <section className="mt-10" aria-label="Reading time per day">
              <div className="shelf-heading">
                <span className="kicker">Last {stats.daily.length} days</span>
                <span className="shelf-rule" aria-hidden="true" />
              </div>
              <div
                className="stats-bars"
                role="img"
                aria-label={stats.daily
                  .map((d) => `${dayLabel(d.date)}: ${dur(d.seconds)}`)
                  .join(', ')}
              >
                {stats.daily.map((d, i) => (
                  <div
                    key={d.date}
                    className={`stats-bar-col${
                      i === stats.daily.length - 1 ? ' is-today' : ''
                    }`}
                  >
                    <div
                      className="stats-bar"
                      style={{
                        height: `${Math.max(2, (d.seconds / maxDay) * 100)}%`,
                      }}
                    >
                      <span className="stats-tip">
                        {dayLabel(d.date)} · {dur(d.seconds)}
                      </span>
                    </div>
                    <span className="stats-bar-label">
                      {i % 2 === 0 || i === stats.daily.length - 1
                        ? dayLabel(d.date).split(' ')[1]
                        : ''}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {stats.per_book.length > 0 && (
              <section className="mt-10" aria-label="Time per book">
                <div className="shelf-heading">
                  <span className="kicker">By book</span>
                  <span className="shelf-rule" aria-hidden="true" />
                </div>
                <ul className="stats-book-list">
                  {stats.per_book.map((b) => (
                    <li key={b.book_id} className="stats-book-row">
                      <div className="stats-book-head">
                        <span className="stats-book-title" title={b.title}>
                          {b.title}
                        </span>
                        <span className="stats-book-time">{dur(b.sec)}</span>
                      </div>
                      <div className="stats-track">
                        <div
                          className="stats-fill"
                          style={{ width: `${(b.sec / maxBook) * 100}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="mt-10 grid gap-10 sm:grid-cols-2">
              {stats.by_format.length > 0 && (
                <div aria-label="Time by format">
                  <div className="shelf-heading">
                    <span className="kicker">By format</span>
                    <span className="shelf-rule" aria-hidden="true" />
                  </div>
                  <ul className="stats-mini-list">
                    {stats.by_format.map((f) => (
                      <li key={f.format}>
                        <span className="stats-mini-label">
                          {f.format.toUpperCase()}
                        </span>
                        <span className="stats-track">
                          <span
                            className="stats-fill"
                            style={{
                              width: `${(f.seconds / stats.total_s) * 100}%`,
                            }}
                          />
                        </span>
                        <span className="stats-mini-time">{dur(f.seconds)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {stats.by_state.some((s) => s.seconds > 0) && (
                <div aria-label="Time by reading state">
                  <div className="shelf-heading">
                    <span className="kicker">By state</span>
                    <span className="shelf-rule" aria-hidden="true" />
                  </div>
                  <ul className="stats-mini-list">
                    {stats.by_state
                      .filter((s) => s.seconds > 0)
                      .map((s) => (
                        <li key={s.state}>
                          <span className="stats-mini-label">
                            {s.state.toUpperCase()}
                          </span>
                          <span className="stats-track">
                            <span
                              className="stats-fill"
                              style={{
                                width: `${(s.seconds / stats.total_s) * 100}%`,
                              }}
                            />
                          </span>
                          <span className="stats-mini-time">
                            {dur(s.seconds)}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
