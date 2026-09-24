import { useState } from 'react'
import { requestGeneration } from '../api/client'
import { usePlayerStore } from '../stores/playerStore'
import type { Timeline } from '../player/timeline'

/**
 * Sections dropdown. Every section is clickable — reading never waits for
 * audio. Ready sections jump-and-seek; pending ones move the reading cursor
 * and boost their audio (see playerStore.jumpToSection). Failed sections
 * offer an inline retry (generate?boost force-requeues them).
 */
export default function ChapterMenu({ timeline }: { timeline: Timeline }) {
  const [open, setOpen] = useState(false)
  const sectionIdx = usePlayerStore((s) => s.sectionIdx)
  const bookId = usePlayerStore((s) => s.bookId)
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
            <div
              key={e.section}
              role="button"
              tabIndex={0}
              className={`flex w-full cursor-pointer items-center rounded px-2 py-1 text-left text-sm hover:bg-[var(--surface-2)] ${
                e.section === sectionIdx ? 'font-semibold' : ''
              }`}
              onClick={() => {
                setOpen(false)
                usePlayerStore.getState().jumpToSection(e.section)
              }}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') {
                  setOpen(false)
                  usePlayerStore.getState().jumpToSection(e.section)
                }
              }}
              title={
                e.ready
                  ? 'jump to chapter'
                  : `${e.status} — jump anyway; its audio gets priority`
              }
            >
              <span className="min-w-0 flex-1 truncate">
                {e.title || `Section ${e.section + 1}`}
                {e.status !== 'ready' && (
                  <span
                    className="ml-1 text-xs"
                    style={{
                      color: e.status === 'failed' ? 'var(--danger)' : 'var(--muted)',
                    }}
                  >
                    · {e.status === 'pending' ? '⏳ pending' : `⚠ ${e.status}`}
                  </span>
                )}
              </span>
              {e.status === 'failed' && (
                <button
                  className="btn btn-ghost btn-sm ml-2 shrink-0"
                  title="retry narration for this section"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    if (bookId) void requestGeneration(bookId, e.section)
                  }}
                >
                  ↻
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
