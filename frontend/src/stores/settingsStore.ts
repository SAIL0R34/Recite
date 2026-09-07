import { create } from 'zustand'
import type { Settings } from '../types'
import { getSettings, putSettings } from '../api/client'

const DEFAULTS: Settings = {
  voice: 'af_heart',
  theme: 'light',
  fontSize: 19,
  lineHeight: 1.7,
  fontFamily: '',
  highlightStyle: 'highlighter',
  alignment: 'whisperx',
}

function applyTheme(s: Settings | null): void {
  if (typeof document === 'undefined' || !s) return
  const el = document.documentElement
  el.dataset.theme = s.theme
  el.classList.toggle('dark', s.theme === 'dark')
  el.style.setProperty('--reader-font-size', `${s.fontSize}px`)
  el.style.setProperty('--reader-line-height', String(s.lineHeight))
  if (s.fontFamily) el.style.setProperty('--reader-font', s.fontFamily)
  else el.style.removeProperty('--reader-font')
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,

  async load() {
    try {
      const s = await getSettings()
      set({ settings: s, loaded: true })
      applyTheme(s)
    } catch {
      // Backend not up yet — render with defaults, retry once on next mount.
      set({ settings: DEFAULTS, loaded: false })
      applyTheme(DEFAULTS)
    }
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
    const cur = get().settings?.theme ?? 'light'
    const next = order[(order.indexOf(cur) + 1) % order.length]
    get().update({ theme: next })
  },
}))
