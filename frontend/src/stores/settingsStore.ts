import { create } from 'zustand'
import type { Settings } from '../types'
import { getSettings, putSettings } from '../api/client'

// Mirrors backend/app/config.py DEFAULT_SETTINGS — keep the two in sync.
const DEFAULTS: Settings = {
  voice: 'af_heart',
  theme: 'sepia',
  fontSize: 19,
  lineHeight: 1.7,
  fontFamily: 'Georgia, serif',
  highlightStyle: 'highlighter',
  alignment: 'auto',
}

/** Cache key read by the pre-paint script in index.html to avoid a theme flash. */
const CACHE_KEY = 'recite:settings'

function applyTheme(s: Settings | null): void {
  if (typeof document === 'undefined' || !s) return
  const el = document.documentElement
  el.dataset.theme = s.theme
  el.classList.toggle('dark', s.theme === 'dark')
  el.style.setProperty('--reader-font-size', `${s.fontSize}px`)
  el.style.setProperty('--reader-line-height', String(s.lineHeight))
  if (s.fontFamily) el.style.setProperty('--reader-font', s.fontFamily)
  else el.style.removeProperty('--reader-font')
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      theme: s.theme,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      fontFamily: s.fontFamily,
    }))
  } catch {
    /* storage unavailable (private mode) — flash comes back, nothing breaks */
  }
}

interface SettingsState {
  settings: Settings | null
  loaded: boolean
  load: () => Promise<void>
  /** Optimistic local update + debounced PUT (survives rapid slider drags). */
  update: (patch: Partial<Settings>) => void
  cycleTheme: () => void
}

let putTimer: ReturnType<typeof setTimeout> | null = null
let inflight: Promise<void> | null = null

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,

  async load() {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const s = await getSettings()
        set({ settings: s, loaded: true })
        applyTheme(s)
      } catch {
        // Backend not up yet — render with defaults, retry once on next mount.
        set({ settings: DEFAULTS, loaded: false })
        applyTheme(DEFAULTS)
      } finally {
        inflight = null
      }
    })()
    return inflight
  },

  update(patch) {
    const next = { ...(get().settings ?? DEFAULTS), ...patch }
    set({ settings: next })
    applyTheme(next)
    if (putTimer) clearTimeout(putTimer)
    putTimer = setTimeout(() => {
      putSettings(next).catch(() => {
        /* backend offline — local state stays until next load */
      })
    }, 250)
  },

  cycleTheme() {
    const order = ['light', 'sepia', 'dark'] as const
    const cur = get().settings?.theme ?? 'sepia'
    const next = order[(order.indexOf(cur) + 1) % order.length]
    get().update({ theme: next })
  },
}))
