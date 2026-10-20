import { create } from 'zustand'

/** One-shot praise bursts (confetti). Mounted at App level like the flight. */
interface PraiseState {
  nonce: number
  x: number
  y: number
  intensity: number
  burst: (x: number, y: number, intensity?: number) => void
}

export const usePraiseStore = create<PraiseState>((set) => ({
  nonce: 0,
  x: 0,
  y: 0,
  intensity: 1,
  burst: (x, y, intensity = 1) =>
    set((s) => ({ nonce: s.nonce + 1, x, y, intensity })),
}))
