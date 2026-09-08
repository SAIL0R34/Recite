import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import SpeedPopover from './SpeedPopover'
import type { Timeline } from '../player/timeline'
import { globalToReady } from '../player/timeline'

/* ---------- inline icons (no emoji anywhere on the transport) ---------- */

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
      <polygon points="6 3.5 20 12 6 20.5" fill="currentColor" />
    </svg>
  )
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
      <rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" />
    </svg>
  )
}
function RewindIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <polyline points="1.7 4 1.7 10 7.7 10" />
      <path d="M3.8 15a9 9 0 1 0 2.13-9.36L1.7 10" />
    </svg>
  )
}
function ForwardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <polyline points="22.3 4 22.3 10 16.3 10" />
      <path d="M20.2 15a9 9 0 1 1-2.12-9.36L22.3 10" />
    </svg>
  )
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Bottom transport: title row with a live "streaming" badge and the utility
 * cluster (speed / bookmarks / theme), the scrubber on the READY axis with
 * gap ticks, and a pure centered play row.
 */
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
  const streaming = !!cur && cur.status !== 'ready' && cur.partialMs > 0
  const notReady = cur && cur.status !== 'ready' && cur.partialMs <= 0
  const remaining = Math.max(0, timeline.readyMs - readyPos)
  const playedPct = timeline.readyMs
    ? (readyPos / timeline.readyMs) * 100
    : 0

  // gap ticks on the ready axis (where a ready segment ends → gap begins)
  const ticks: { left: number }[] = []
  for (let i = 0; i < timeline.readySegments.length - 1; i++) {
    const seg = timeline.readySegments[i]
    const next = timeline.readySegments[i + 1]
    const gapMs = next.globalStart - (seg.globalStart + seg.durationMs)
    if (gapMs > 0)
      ticks.push({
        left: ((seg.readyStart + seg.durationMs) / timeline.readyMs) * 100,
      })
  }

  return (
    <div
      className="border-t px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 sm:px-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {/* row 1 — title, streaming badge, time, utilities */}
      <div
        className="mb-1 flex min-w-0 items-center gap-2 text-xs"
        style={{ color: 'var(--muted)' }}
      >
        <span
          className="min-w-0 flex-1 truncate font-medium"
          style={{ color: 'var(--fg)' }}
          title={cur?.title}
        >
          {cur?.title || '—'}
        </span>
        {streaming && (
          <span
            className="shrink-0 rounded-full px-2 py-0.5 font-semibold"
            style={{
              color: 'var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
            }}
            title="Narration for this part is still rendering; playback continues as it grows"
          >
            ● streaming
          </span>
        )}
        <span className="tabular-nums shrink-0">{fmt(readyPos)}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums shrink-0" title="remaining">
          −{fmt(remaining)}
        </span>
        <div className="util-cluster shrink-0">
          <SpeedPopover rate={rate} />
          <button
            className="btn btn-ghost"
            onClick={onToggleBookmarks}
            title="Bookmarks (B to pin)"
            aria-label="bookmarks"
          >
            🔖
          </button>
          <button
            className="btn btn-ghost"
            onClick={cycleTheme}
            title="Theme"
            aria-label="cycle theme"
          >
            ◐
          </button>
        </div>
      </div>

      {/* row 2 — the scrubber */}
      <div className="relative">
        <input
          type="range"
          className="scrub"
          style={{ ['--played' as never]: `${playedPct}%` }}
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
        {ticks.map((t, i) => (
          <span
            key={i}
            className="gap-tick"
            style={{ left: `${t.left}%` }}
            aria-hidden
          />
        ))}
      </div>

      {/* row 3 — the centered trio; next-ready pinned left */}
      <div className="relative mt-1 flex items-center justify-center gap-2 sm:gap-3">
        <span className="absolute left-0">
          {notReady && (
            <button
              className="btn btn-sm"
              onClick={() => usePlayerStore.getState().nextReadySection()}
              title="Jump to next ready section"
            >
              next ready →
            </button>
          )}
        </span>

        <button
          className="skip-btn"
          onClick={() => usePlayerStore.getState().seekBy(-10_000)}
          title="Back 10s (←)"
          aria-label="back 10 seconds"
        >
          <RewindIcon />
          <span aria-hidden>10</span>
        </button>
        <button
          className="play-btn"
          onClick={() => usePlayerStore.getState().toggle()}
          title="Play/pause (space)"
          aria-label={playing ? 'pause' : 'play'}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          className="skip-btn"
          onClick={() => usePlayerStore.getState().seekBy(10_000)}
          title="Forward 10s (→)"
          aria-label="forward 10 seconds"
        >
          <ForwardIcon />
          <span aria-hidden>10</span>
        </button>
      </div>
    </div>
  )
}
