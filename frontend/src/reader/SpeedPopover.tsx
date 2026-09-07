import { useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'

const PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2]

export default function SpeedPopover({ rate }: { rate: number }) {
  const [open, setOpen] = useState(false)
  const setRate = usePlayerStore((s) => s.setRate)
  return (
    <div className="relative">
      <button className="btn btn-sm" onClick={() => setOpen((v) => !v)} title="Playback speed">
        {rate.toFixed(2).replace(/\.?0+$/, '')}×
      </button>
      {open && (
        <div
          className="card absolute bottom-9 right-0 z-30 p-3"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="mb-2 flex flex-wrap gap-1">
            {PRESETS.map((r) => (
              <button
                key={r}
                className={`btn btn-sm ${r === rate ? 'btn-accent' : ''}`}
                onClick={() => setRate(r)}
              >
                {r}×
              </button>
            ))}
          </div>
          <input
            type="range"
            className="speed"
            min={0.5}
            max={2.5}
            step={0.05}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
          <p className="mt-1 text-center text-xs" style={{ color: 'var(--muted)' }}>
            0.5× – 2.5×
          </p>
        </div>
      )}
    </div>
  )
}
