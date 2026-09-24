// Shared types mirroring the backend contract (docs/CONTRACT.md).

export interface BookSummary {
  id: string
  title: string
  author: string
  format: string
  status: string
  warnings: string[]
  total_words: number
  percent: number
  path: string
  created_at: string
  updated_at: string
  /** epoch seconds of the last reading session; null when never opened */
  last_read?: number | null
}

export interface LibraryEntry {
  path: string
  name: string
  size: number
}

export interface DocSentence {
  idx: number
  text: string
  words: string[]
}

export interface DocParagraph {
  idx: number
  page: number | null
  anchor: string | null
  no_tts?: boolean
  sentences: DocSentence[]
}

export interface DocSection {
  idx: number
  title?: string
  paragraphs: DocParagraph[]
}

export interface BookDocument {
  id: string
  title: string
  author: string
  format: string
  sections: DocSection[]
  warnings: string[]
}

export interface WordTiming {
  w: number
  s: number
  e: number
}

export interface ManifestChunk {
  idx: number
  section: number
  para: number
  sentence_range: [number, number]
  text: string
  global_start_ms: number
  duration_ms: number
  status: string
  words: WordTiming[] | null
}

export interface ManifestSection {
  idx: number
  title?: string
  audio: string
  duration_ms: number
  status: string
  /** playable prefix audio while the section still synthesizes */
  partial_audio?: string | null
  partial_ms?: number
  chunks: ManifestChunk[]
}

export interface Manifest {
  engine: string
  voice: string
  alignment: string
  sections: ManifestSection[]
}

export interface Progress {
  section_idx: number
  word_idx: number
  ms_into_section: number
  percent: number
  /** was the player playing when this snapshot was saved */
  active?: number
  /** global-ms start of section_idx in the manifest that produced it */
  section_start_ms?: number
}

export interface Bookmark {
  id: string
  name: string
  section_idx: number
  ms: number
  created_at?: string
}

export type Theme = 'light' | 'sepia' | 'dark'
export type HighlightStyle = 'highlighter' | 'underline'

export interface Settings {
  voice: string
  theme: Theme
  fontSize: number
  lineHeight: number
  fontFamily: string
  highlightStyle: HighlightStyle
  alignment: string
}

export interface StatusCounts {
  total: number
  ready: number
  failed: number
  active: number
}

export interface BookEventHandlers {
  onSection?: (e: { idx: number; status: string }) => void
  onChunk?: (e: { idx: number; chunk: number }) => void
  onGeneration?: (e: { done: boolean }) => void
}

/** user-marked passage; anchored by (section, paragraph, token range) */
export interface Highlight {
  id: string
  book_id: string
  section_idx: number
  para_idx: number
  start_ti: number
  end_ti: number
  color: string
  text: string
  created_at: number
}
