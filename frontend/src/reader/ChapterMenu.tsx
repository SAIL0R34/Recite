import { useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import type { Timeline } from '../player/timeline'

/**
 * Sections dropdown. Every section is clickable — reading never waits for
 * audio. Ready sections jump-and-seek; pending ones move the reading cursor
 * and boost their audio (see playerStore.jumpToSection).
 */
export default function ChapterMenu({ timeline }: { timeline: Timeline }) {
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
                usePlayerStore.getState().jumpToSection(e.section)
              }}
              title={
                e.ready
                  ? 'jump to chapter'
                  : `${e.status} — jump anyway; its audio gets priority`
              }
            >
              {e.title || `Section ${e.section + 1}`}
              {e.status !== 'ready' && (
                <span className="ml-1 text-xs" style={{ color: 'var(--muted)' }}>
                  · {e.status === 'pending' ? '⏳ pending' : e.status}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
