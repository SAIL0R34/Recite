import { create } from 'zustand'

/** Praise bursts (confetti), mounted at App level like the flight. Each
 *  burst is its own layer with its own origin and lifecycle, so overlapping
 *  volleys (the 240ms "again!" second throw, the session crown) never drag
 *  earlier bits to a new origin mid-flight. */
export interface PraiseBurst {
  id: number
  x: number
  y: number
  intensity: number
}

interface PraiseState {
  bursts: PraiseBurst[]
  burst: (x: number, y: number, intensity?: number) => void
  /** called by the layer itself when its bits have lived out */
  prune: (id: number) => void
}

let seq = 0

export const usePraiseStore = create<PraiseState>((set) => ({
  bursts: [],
  burst: (x, y, intensity = 1) =>
    set((s) => ({
      bursts: [...s.bursts.slice(-4), { id: ++seq, x, y, intensity }],
    })),
  prune: (id) =>
    set((s) => ({ bursts: s.bursts.filter((b) => b.id !== id) })),
}))
