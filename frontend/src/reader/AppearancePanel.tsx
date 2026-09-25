import { useSettingsStore } from '../stores/settingsStore'
import type { HighlightStyle, ReadingMode, Theme } from '../types'

const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'dark', label: 'Dark' },
]

const FONTS = [
  { id: '', label: 'Georgia (serif)' },
  { id: "ui-serif, Georgia, 'Times New Roman', serif", label: 'System serif' },
  { id: "ui-sans-serif, system-ui, sans-serif", label: 'Sans' },
  { id: "'SF Mono', ui-monospace, Menlo, monospace", label: 'Mono' },
]

export default function AppearancePanel() {
  const s = useSettingsStore((st) => st.settings)
  const update = useSettingsStore((st) => st.update)
  if (!s) return null
  return (
    <div className="card w-72 space-y-3 p-4 text-sm">
      <div>
        <p className="mb-1 font-medium">Theme</p>
        <div className="flex gap-1">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`btn btn-sm ${s.theme === t.id ? 'btn-accent' : ''}`}
              onClick={() => update({ theme: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1 font-medium">
          Font size — {s.fontSize}px
        </p>
        <input
          type="range"
          min={14}
          max={30}
          value={s.fontSize}
          className="w-full"
          style={{ accentColor: 'var(--accent)' }}
          onChange={(e) => update({ fontSize: Number(e.target.value) })}
        />
      </div>
      <div>
        <p className="mb-1 font-medium">
          Line height — {s.lineHeight.toFixed(1)}
        </p>
        <input
          type="range"
          min={1.2}
          max={2.2}
          step={0.1}
          value={s.lineHeight}
          className="w-full"
          style={{ accentColor: 'var(--accent)' }}
          onChange={(e) => update({ lineHeight: Number(e.target.value) })}
        />
      </div>
      <div>
        <p className="mb-1 font-medium">Font</p>
        <select
          className="input"
          value={s.fontFamily}
          onChange={(e) => update({ fontFamily: e.target.value })}
        >
          {FONTS.map((f) => (
            <option key={f.label} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <p className="mb-1 font-medium">Highlight style</p>
        <div className="flex gap-1">
          {(
            [
              ['highlighter', 'Highlighter'],
              ['underline', 'Underline'],
            ] as [HighlightStyle, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={`btn btn-sm ${s.highlightStyle === id ? 'btn-accent' : ''}`}
              onClick={() => update({ highlightStyle: id })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1 font-medium">Reading</p>
        <div className="flex gap-1">
          {(
            [
              ['scroll', 'Scroll'],
              ['paged', 'Pages'],
            ] as [ReadingMode, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={`btn btn-sm ${s.readingMode === id ? 'btn-accent' : ''}`}
              onClick={() => update({ readingMode: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Pages fill the screen and turn; narration flips them for you.
        </p>
      </div>
      <div>
        <p className="mb-1 font-medium">Animations</p>
        <div className="flex gap-1">
          {(
            [
              [true, 'On'],
              [false, 'Off'],
            ] as [boolean, string][]
          ).map(([id, label]) => (
            <button
              key={label}
              className={`btn btn-sm ${s.pageAnimations === id ? 'btn-accent' : ''}`}
              onClick={() => update({ pageAnimations: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Page-turn slide, smooth jumps, gentle open. Off unless you opt in;
          Reduce Motion always wins.
        </p>
      </div>
    </div>
  )
}
