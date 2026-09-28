// Book-open flight: the cover's viewport rect, captured at click time in
// the library, handed to the BookTransition overlay once the reader route
// mounts. One-shot — consumed on activation, never held here.

import { create } from 'zustand'

export interface FlightPayload {
  nonce: number
  bookId: string
  /** viewport px, captured at click */
  from: { x: number; y: number; w: number; h: number }
  kind: 'img' | 'typo'
  title: string
  author: string
}

interface FlightState {
  pending: FlightPayload | null
  begin: (p: Omit<FlightPayload, 'nonce'>) => void
  clear: () => void
}

let nonce = 0

export const useFlightStore = create<FlightState>((set) => ({
  pending: null,
  // Always replaces; the monotonic nonce makes stale activations
  // impossible, so a re-click is simply a new, correct flight.
  begin: (p) => set({ pending: { ...p, nonce: ++nonce } }),
  clear: () => set({ pending: null }),
}))
