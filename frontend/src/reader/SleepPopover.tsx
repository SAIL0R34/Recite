import { useSleepStore } from '../stores/sleepStore'

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  )
}

function fmtLeft(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Sleep timer: presets plus "end of section". While armed, the moon shows
 *  the minutes left and the panel live-counts down; the final seconds fade
 *  the narration out before pausing. */
export default function SleepPopover() {
  const mode = useSleepStore((s) => s.mode)
  const remainingMs = useSleepStore((s) => s.remainingMs)
  const menuOpen = useSleepStore((s) => s.menuOpen)
  const toggleMenu = useSleepStore((s) => s.toggleMenu)
  const setMenuOpen = useSleepStore((s) => s.setMenuOpen)
  const armMinutes = useSleepStore((s) => s.armMinutes)
  const armSection = useSleepStore((s) => s.armSection)
  const cancel = useSleepStore((s) => s.cancel)
  const armed = mode !== 'off'

  return (
    <div className="relative">
      <button
        className="btn btn-sm inline-flex items-center gap-1"
        onClick={toggleMenu}
        title="Sleep timer (Z)"
        aria-label="sleep timer"
        aria-expanded={menuOpen}
      >
        <MoonIcon />
        {armed && (
          <span className="tabular-nums">
            {Math.max(1, Math.ceil(remainingMs / 60_000))}m
          </span>
        )}
      </button>
      {menuOpen && (
        <div
          className="card absolute bottom-9 right-0 z-30 w-44 p-3"
          onMouseLeave={() => setMenuOpen(false)}
        >
          {armed && (
            <p
              className="mb-2 text-center text-sm tabular-nums"
              style={{ color: 'var(--fg)' }}
            >
              {fmtLeft(remainingMs)} left
            </p>
          )}
          <div className="grid grid-cols-2 gap-1">
            {[5, 15, 30, 45].map((m) => (
              <button key={m} className="btn btn-sm" onClick={() => armMinutes(m)}>
                {m} min
              </button>
            ))}
          </div>
          <button className="btn btn-sm mt-1 w-full" onClick={armSection}>
            End of section
          </button>
          {armed && (
            <button className="btn btn-sm mt-1 w-full" onClick={cancel}>
              Cancel timer
            </button>
          )}
        </div>
      )}
    </div>
  )
}
