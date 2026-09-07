import { useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import type { Timeline } from '../player/timeline'

/** Sections/chapters dropdown — jumps go through the single seek path. */
export default function ChapterMenu({
  timeline,
}: {
  timeline: Timeline
}) {
  const [open, setOpen] = useState(false)
  const sectionIdx = usePlayerStore((s) => s.sectionIdx)
  const entries = timeline.entries

  return (
    <div className="relative">
      <button
        className="btn btn-sm"
        onClick={() => setOpen((v) => !v)}
        title="Chapters"
      >
        Chapters ▾
      </button>
      {open && (
        <div
          className="card recite-scroll absolute right-0 top-9 z-30 max-h-80 w-72 overflow-y-auto p-1"
          onMouseLeave={() => setOpen(false)}
        >
          {entries.map((e) => (
            <button
              key={e.section}
              className={`block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-[var(--surface-2)] ${
                e.section === sectionIdx ? 'font-semibold' : ''
              }`}
              onClick={() => {
                setOpen(false)
                if (e.ready) usePlayerStore.getState().seek(e.startMs)
              }}
              disabled={!e.ready}
              title={e.ready ? undefined : 'generating…'}
            >
              {e.title || `Section ${e.section + 1}`}
              {e.status !== 'ready' && (
                <span className="ml-1 text-xs" style={{ color: 'var(--muted)' }}>
                  · {e.status}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
