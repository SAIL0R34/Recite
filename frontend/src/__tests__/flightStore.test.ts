// Flight store contract: pure store, node environment.

import { beforeEach, describe, expect, it } from 'vitest'
import { useFlightStore } from '../stores/flightStore'

describe('flightStore', () => {
  beforeEach(() => {
    useFlightStore.getState().endFlight()
  })

  it('begins a flight with the first nonce, active', () => {
    useFlightStore.getState().begin({
      bookId: 'b1',
      kind: 'img',
      title: 'T',
      author: 'A',
      from: { x: 1, y: 2, w: 80, h: 120 },
    })
    const p = useFlightStore.getState().pending
    expect(p?.nonce).toBe(1)
    expect(p?.bookId).toBe('b1')
    expect(useFlightStore.getState().active).toBe(true)
  })

  it('always replaces and increments the nonce', () => {
    const begin = useFlightStore.getState().begin
    begin({ bookId: 'a', kind: 'img', title: '', author: '', from: { x: 0, y: 0, w: 10, h: 15 } })
    begin({ bookId: 'b', kind: 'img', title: '', author: '', from: { x: 0, y: 0, w: 10, h: 15 } })
    const p = useFlightStore.getState().pending
    expect(p?.bookId).toBe('b')
    expect(p?.nonce).toBeGreaterThan(1)
  })

  it('clear drops the payload but keeps the flight active', () => {
    useFlightStore.getState().begin({
      bookId: 'a', kind: 'img', title: '', author: '',
      from: { x: 0, y: 0, w: 10, h: 15 },
    })
    useFlightStore.getState().clear()
    expect(useFlightStore.getState().pending).toBeNull()
    expect(useFlightStore.getState().active).toBe(true)
  })

  it('endFlight settles everything', () => {
    useFlightStore.getState().begin({
      bookId: 'a', kind: 'img', title: '', author: '',
      from: { x: 0, y: 0, w: 10, h: 15 },
    })
    useFlightStore.getState().endFlight()
    expect(useFlightStore.getState().pending).toBeNull()
    expect(useFlightStore.getState().active).toBe(false)
  })
})
