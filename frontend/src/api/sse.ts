// SSE subscription for per-book generation events, with a polling fallback.
// Backend emits *named* events: "section" {idx,status} and "generation" {done}.

import type { BookEventHandlers } from '../types'

export const sseSupported = (): boolean =>
  typeof EventSource !== 'undefined'

/**
 * Subscribe to /api/books/{id}/events. Returns an unsubscribe function.
 * If EventSource is unavailable this is a no-op — callers should fall back
 * to polling /status.
 */
export function subscribeToBookEvents(
  id: string,
  handlers: BookEventHandlers,
): () => void {
  if (!sseSupported()) return () => {}
  let es: EventSource
  try {
    es = new EventSource(`/api/books/${encodeURIComponent(id)}/events`)
  } catch {
    return () => {}
  }
  es.addEventListener('section', (e) => {
    try {
      handlers.onSection?.(JSON.parse((e as MessageEvent).data))
    } catch {
      /* malformed frame — ignore */
    }
  })
  es.addEventListener('chunk', (e) => {
    try {
      handlers.onChunk?.(JSON.parse((e as MessageEvent).data))
    } catch {
      /* ignore */
    }
  })
  es.addEventListener('generation', (e) => {
    try {
      handlers.onGeneration?.(JSON.parse((e as MessageEvent).data))
    } catch {
      /* ignore */
    }
  })
  es.addEventListener('model', (e) => {
    try {
      handlers.onModel?.(JSON.parse((e as MessageEvent).data))
    } catch {
      /* ignore */
    }
  })
  return () => es.close()
}
