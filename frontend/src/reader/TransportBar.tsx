import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import SpeedPopover from './SpeedPopover'
import type { Timeline } from '../player/timeline'
import { globalToReady } from '../player/timeline'

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export default function TransportBar({
  timeline,
  onToggleBookmarks,
}: {
  timeline: Timeline
  onToggleBookmarks: () => void
}) {
  const globalMs = usePlayerStore((s) => s.globalMs)
  const playing = usePlayerStore((s) => s.playing)
  const rate = usePlayerStore((s) => s.rate)
  const sectionIdx = usePlayerStore((s) => s.sectionIdx)
  const cycleTheme = useSettingsStore((s) => s.cycleTheme)

  const readyPos = globalToReady(timeline, globalMs)
  const cur = timeline.byIndex[sectionIdx]
  const notReady = cur && cur.status !== 'ready'

  // gap ticks on the ready axis (where a ready segment ends → gap begins)
  const ticks: { left: number }[] = []
  for (let i = 0; i < timeline.readySegments.length - 1; i++) {
    const seg = timeline.readySegments[i]
    const next = timeline.readySegments[i + 1]
    const gapMs =
      next.globalStart - (seg.globalStart + seg.durationMs)
    if (gapMs > 0)
      ticks.push({
        left: ((seg.readyStart + seg.durationMs) / timeline.readyMs) * 100,
      })
  }

  return (
    <div
      className="flex items-center gap-3 border-t px-4 py-2"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <button
        className="btn btn-ghost"
        onClick={() => usePlayerStore.getState().seekBy(-10_000)}
        title="Back 10s (←)"
      >
        ⏪10
      </button>
      <button
        className="btn btn-accent"
        onClick={() => usePlayerStore.getState().toggle()}
        title="Play/pause (space)"
        style={{ minWidth: '3.2rem' }}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <button
        className="btn btn-ghost"
        onClick={() => usePlayerStore.getState().seekBy(10_000)}
        title="Forward 10s (→)"
      >
        10⏩
      </button>

      <span className="tabular-nums text-xs" style={{ color: 'var(--muted)' }}>
        {fmt(readyPos)}
      </span>

      <div className="relative min-w-[8rem] flex-1">
        <input
          type="range"
          className="scrub"
          min={0}
          max={Math.max(1, timeline.readyMs)}
          step={100}
          value={readyPos}
          disabled={timeline.readyMs <= 0}
          onChange={(e) => {
            const v = Number(e.target.value)
            // scrubber works on the READY axis → global → seek path
            const g = timeline.readySegments.length
              ? (() => {
                  let lo = 0
                  let hi = timeline.readySegments.length - 1
                  let idx = 0
                  while (lo <= hi) {
                    const mid = (lo + hi) >> 1
                    const s = timeline.readySegments[mid]
                    if (s.readyStart <= v) {
                      idx = mid
                      lo = mid + 1
                    } else hi = mid - 1
                  }
                  const seg = timeline.readySegments[idx]
                  if (v <= seg.readyStart + seg.durationMs)
                    return seg.globalStart + (v - seg.readyStart)
                  const nx = timeline.readySegments[idx + 1]
                  return nx ? nx.globalStart : seg.globalStart + seg.durationMs
                })()
              : 0
            usePlayerStore.getState().seek(g)
          }}
          aria-label="seek"
        />
        {/* gap ticks: where un-generated audio sits */}
        {ticks.map((t, i) => (
          <span
            key={i}
            className="gap-tick"
            style={{ left: `${t.left}%` }}
            title="audio pending"
          />
        ))}
      </div>

      <span className="tabular-nums text-xs" style={{ color: 'var(--muted)' }}>
        {fmt(timeline.readyMs)}
      </span>

      {notReady && (
        <button
          className="btn btn-sm"
          onClick={() => usePlayerStore.getState().nextReadySection()}
          title="Jump to next ready section"
        >
          next ready →
        </button>
      )}

      <SpeedPopover rate={rate} />

      <button
        className="btn btn-ghost"
        onClick={onToggleBookmarks}
        title="Bookmarks (B to pin)"
      >
        🔖
      </button>
      <button className="btn btn-ghost" onClick={cycleTheme} title="Theme">
        ◐
      </button>
    </div>
  )
}
