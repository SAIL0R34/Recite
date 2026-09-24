import { useEffect, useMemo, useRef, useState } from 'react'
import type { BookDocument, Manifest } from '../types'
import { usePlayerStore } from '../stores/playerStore'
import type { Timeline } from '../player/timeline'
import { buildSearchIndex, searchIndex, snippet } from './search'

/**
 * In-book search ( / ). Matches list with context snippets; clicking a hit
 * seeks to its chunk when the section is ready (slim manifests keep
 * global_start_ms + sentence_range), otherwise jumps to the section and
 * boosts its audio. The eye lands on the paragraph via a short flash.
 */
export default function SearchPopover({
  doc,
  manifest,
  timeline,
  open,
  onOpenChange,
}: {
  doc: BookDocument
  manifest: Manifest
  timeline: Timeline
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const index = useMemo(() => buildSearchIndex(doc), [doc])
  const hits = useMemo(() => searchIndex(index, debounced), [index, debounced])

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q)
      setActive(0)
    }, 120)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    if (open) {
      setQ('')
      setDebounced('')
      setActive(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const jumpTo = (hit: (typeof hits)[number]) => {
    const sec = manifest.sections.find((s) => s.idx === hit.sec)
    const entry = timeline.byIndex[hit.sec]
    const chunk =
      entry?.ready && sec
        ? sec.chunks.find(
            (c) =>
              c.para === hit.para &&
              hit.sent >= c.sentence_range[0] &&
              hit.sent <= c.sentence_range[1],
          )
        : undefined
    if (entry?.ready && chunk)
      usePlayerStore.getState().seek(entry.startMs + chunk.global_start_ms)
    else usePlayerStore.getState().jumpToSection(hit.sec)
    // land the eye on the paragraph once the ±1 window has rendered
    setTimeout(() => {
      const el = document.querySelector(
        `[data-section="${hit.sec}"] span[data-para="${hit.para}"]`,
      )
      const p = el?.closest('p')
      p?.scrollIntoView({ block: 'center' })
      p?.classList.add('search-flash')
      setTimeout(() => p?.classList.remove('search-flash'), 1400)
    }, 80)
    onOpenChange(false)
  }

  if (!open) return null

  return (
    <div className="relative">
      <button
        className="btn btn-sm"
        onClick={() => onOpenChange(false)}
        title="Search ( / )"
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
          focusable="false"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
      </button>
      <div className="card recite-scroll absolute right-0 top-9 z-30 max-h-[28rem] w-96 overflow-y-auto p-2">
        <input
          ref={inputRef}
          className="input mb-2 w-full"
          placeholder="Search this book…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[active]) {
              e.preventDefault()
              jumpTo(hits[active])
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(i + 1, hits.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            }
          }}
        />
        {debounced.trim().length < 2 ? (
          <p className="px-1 py-2 text-xs" style={{ color: 'var(--muted)' }}>
            type at least 2 characters
          </p>
        ) : hits.length === 0 ? (
          <p className="px-1 py-2 text-xs" style={{ color: 'var(--muted)' }}>
            No matches
          </p>
        ) : (
          <>
            {hits.map((h, i) => {
              const sn = snippet(h)
              return (
                <button
                  key={`${h.sec}-${h.para}-${h.sent}-${i}`}
                  className={`block w-full rounded px-2 py-1.5 text-left text-sm ${
                    i === active ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'
                  }`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => jumpTo(h)}
                >
                  <span
                    className="block truncate text-xs"
                    style={{ color: 'var(--muted)' }}
                  >
                    {h.title}
                  </span>
                  <span className="block">
                    {sn.pre}
                    <span
                      style={{ background: 'var(--hl)', color: 'var(--hl-fg)' }}
                    >
                      {sn.match}
                    </span>
                    {sn.post}
                  </span>
                </button>
              )
            })}
            <p
              className="px-2 pt-1 text-xs"
              style={{ color: 'var(--muted)' }}
            >
              showing first {hits.length}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
