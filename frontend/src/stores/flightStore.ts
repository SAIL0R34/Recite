// Book-open flight: the cover's viewport rect, captured at click time in
// the library. The BookTransition overlay drives the whole choreography
// (lift → fly → open → fade) and the navigation itself, so the library can
// visibly recede before the route swaps. One-shot — the payload is
// consumed on activation; `active` stays true until the flight ends so
// the library can style itself mid-lift.

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
  /** a flight is running (payload may already be consumed) */
  active: boolean
  begin: (p: Omit<FlightPayload, 'nonce'>) => void
  clear: () => void
  endFlight: () => void
}

let nonce = 0

export const useFlightStore = create<FlightState>((set) => ({
  pending: null,
  active: false,
  // Always replaces; the monotonic nonce makes stale activations
  // impossible, so a re-click is simply a new, correct flight.
  begin: (p) => set({ pending: { ...p, nonce: ++nonce }, active: true }),
  clear: () => set({ pending: null }),
  endFlight: () => set({ pending: null, active: false }),
}))
