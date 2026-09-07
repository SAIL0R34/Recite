// Thin fetch wrapper around the Recite REST API.
// IMPORTANT: every URL here is relative (/api/...) so the built SPA can be
// served by any origin (Vite dev proxy, FastAPI static mount, Tauri).

import type {
  BookSummary,
  Bookmark,
  LibraryEntry,
  BookDocument,
  Manifest,
  Progress,
  Settings,
  StatusCounts,
} from '../types'

export class ApiError extends Error {
  status: number
  detail: string

  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
    this.detail = detail
    this.name = 'ApiError'
  }
}

async function extractDetail(res: Response): Promise<string> {
  let body: unknown = null
  try {
    body = await res.clone().json()
  } catch {
    try {
      return (await res.text()).slice(0, 300) || res.statusText
    } catch {
      return res.statusText
    }
  }
  if (typeof body === 'string') return body
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    if (typeof o.detail === 'string') return o.detail
    if (typeof o.message === 'string') return o.message
    if (typeof o.detail === 'object' && o.detail !== null) {
      // FastAPI validation arrays → flatten the first message
      const d = o.detail as { msg?: string; loc?: unknown[] }
      if (d && typeof d === 'object' && 'msg' in d) return String(d.msg)
    }
  }
  return res.statusText
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    throw new ApiError(res.status, await extractDetail(res))
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const j = (body: unknown): string => JSON.stringify(body)

// ---- books ----

export const listBooks = (): Promise<BookSummary[]> => request('/api/books')

export const getLibrary = (): Promise<LibraryEntry[]> =>
  request('/api/books/library')

export const addBook = (path: string) =>
  request<{ book: BookSummary; already_present: boolean }>('/api/books', {
    method: 'POST',
    body: j({ path }),
  })

export const deleteBook = (id: string) =>
  request(`/api/books/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const getDocument = (id: string): Promise<BookDocument> =>
  request(`/api/books/${encodeURIComponent(id)}/document`)

export const getManifest = (id: string): Promise<Manifest> =>
  request(`/api/books/${encodeURIComponent(id)}/manifest`)

export const getStatus = (id: string): Promise<StatusCounts> =>
  request(`/api/books/${encodeURIComponent(id)}/status`)

// ---- audio ----

/** Base path for section MP3s (FileResponse → Range support is free). */
export const audioBase = (id: string): string =>
  `/api/books/${encodeURIComponent(id)}/audio/`

// ---- progress ----

export const getProgress = (id: string): Promise<Progress | null> =>
  request<Progress>(`/api/books/${encodeURIComponent(id)}/progress`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  })

export const putProgress = (id: string, p: Progress) =>
  request(`/api/books/${encodeURIComponent(id)}/progress`, {
    method: 'PUT',
    body: j(p),
  })

/** Final flush on pagehide — sendBeacon needs text/plain for most backends. */
export const sendProgressBeacon = (id: string, p: Progress): boolean => {
  try {
    return navigator.sendBeacon(
      `/api/books/${encodeURIComponent(id)}/progress/beacon`,
      new Blob([JSON.stringify(p)], { type: 'text/plain' }),
    )
  } catch {
    return false
  }
}

// ---- bookmarks ----

export const listBookmarks = (id: string): Promise<Bookmark[]> =>
  request(`/api/books/${encodeURIComponent(id)}/bookmarks`)

export const createBookmark = (
  id: string,
  b: { name: string; section_idx: number; ms: number },
): Promise<Bookmark> =>
  request(`/api/books/${encodeURIComponent(id)}/bookmarks`, {
    method: 'POST',
    body: j(b),
  })

export const deleteBookmark = (id: string, bid: string) =>
  request(
    `/api/books/${encodeURIComponent(id)}/bookmarks/${encodeURIComponent(bid)}`,
    { method: 'DELETE' },
  )

// ---- settings ----

export const getSettings = (): Promise<Settings> => request('/api/settings')

export const putSettings = (s: Settings): Promise<Settings> =>
  request('/api/settings', { method: 'PUT', body: j(s) })
