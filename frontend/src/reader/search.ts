// In-book search: pure functions over the already-loaded document, so the
// popover needs no backend round-trip. A hit lands on (section, paragraph,
// sentence); the caller maps that to a chunk seek or a section jump.

import type { BookDocument } from '../types'

export interface SearchDoc {
  sec: number
  para: number
  sent: number
  text: string
  /** section title (or "Section N") for the result label */
  title: string
}

export interface SearchHit extends SearchDoc {
  /** match bounds within `text` */
  start: number
  end: number
}

export function buildSearchIndex(doc: BookDocument): SearchDoc[] {
  const items: SearchDoc[] = []
  for (const s of doc.sections) {
    const title = s.title || `Section ${s.idx + 1}`
    for (const p of s.paragraphs) {
      for (const sent of p.sentences) {
        items.push({
          sec: s.idx,
          para: p.idx,
          sent: sent.idx,
          text: sent.text,
          title,
        })
      }
    }
  }
  return items
}

export function searchIndex(items: SearchDoc[], q: string, cap = 30): SearchHit[] {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return []
  const hits: SearchHit[] = []
  const seenSections = new Set<number>()
  for (const it of items) {
    // a section title matches once, as a virtual entry on its first sentence
    if (!seenSections.has(it.sec)) {
      seenSections.add(it.sec)
      const at = it.title.toLowerCase().indexOf(needle)
      if (at >= 0)
        hits.push({
          ...it, sent: -1, text: it.title, start: at, end: at + needle.length,
        })
    }
    const at = it.text.toLowerCase().indexOf(needle)
    if (at >= 0) hits.push({ ...it, start: at, end: at + needle.length })
    if (hits.length >= cap) return hits.slice(0, cap)
  }
  return hits
}

export function snippet(
  hit: SearchHit,
  radius = 48,
): { pre: string; match: string; post: string } {
  const start = Math.max(0, hit.start - radius)
  const end = Math.min(hit.text.length, hit.end + radius)
  return {
    pre: (start > 0 ? '…' : '') + hit.text.slice(start, hit.start),
    match: hit.text.slice(hit.start, hit.end),
    post: hit.text.slice(hit.end, end) + (end < hit.text.length ? '…' : ''),
  }
}
