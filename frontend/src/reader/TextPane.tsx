import { useEffect, useMemo, useRef } from 'react'
import type {
  BookDocument,
  DocParagraph,
  DocSection,
  Manifest,
  ManifestSection,
  ManifestChunk,
} from '../types'
import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { Timeline } from '../player/timeline'

interface WordRef {
  el: HTMLElement
  s: number
}

/**
 * Karaoke text pane. Renders the current document section plus one section
 * of padding each side (state-based manual windowing). Words carry
 * data-s/data-e (GLOBAL ms), data-w and data-chunk; a single rAF loop
 * binary-searches the flat [data-w] array and toggles one class on the DOM —
 * no React state per frame.
 */
export default function TextPane({
  doc,
  manifest,
  timeline,
}: {
  doc: BookDocument
  manifest: Manifest
  timeline: Timeline | null
}) {
  const sectionIdx = usePlayerStore((s) => s.sectionIdx)
  const follow = usePlayerStore((s) => s.followMode)
  const manifestVersion = usePlayerStore((s) => s.manifestVersion)
  const highlightStyle = useSettingsStore(
    (s) => s.settings?.highlightStyle ?? 'highlighter',
  )
  const containerRef = useRef<HTMLDivElement | null>(null)
  const wordsRef = useRef<WordRef[]>([])
  const followRef = useRef(follow)
  followRef.current = follow

  // current ± 1 section, only where BOTH document and manifest agree
  const indices = useMemo(() => {
    const out: number[] = []
    for (const i of [sectionIdx - 1, sectionIdx, sectionIdx + 1]) {
      const ds = doc.sections.find((s) => s.idx === i)
      const ms = manifest.sections.find((s) => s.idx === i)
      if (ds && ms) out.push(i)
    }
    return out
  }, [sectionIdx, doc, manifest])

  // (Re)query word spans once per render — not per frame.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const nodes = Array.from(
      el.querySelectorAll<HTMLElement>('[data-w]'),
    )
    wordsRef.current = nodes
      .map((n) => ({ el: n, s: Number(n.dataset.s) }))
      .filter((w) => Number.isFinite(w.s))
      .sort((a, b) => a.s - b.s)
  }, [indices, manifestVersion, doc, manifest])

  // The one rAF loop: find active word (binary search), toggle one class.
  useEffect(() => {
    let raf = 0
    let last: HTMLElement | null = null
    const styleClass =
      highlightStyle === 'underline' ? 'kar-underline' : 'kar-highlighter'
    const tick = () => {
      const g = usePlayerStore.getState().globalMs
      const words = wordsRef.current
      let el: HTMLElement | null = null
      if (words.length) {
        let lo = 0
        let hi = words.length - 1
        let idx = -1
        while (lo <= hi) {
          const m = (lo + hi) >> 1
          if (words[m].s <= g) {
            idx = m
            lo = m + 1
          } else {
            hi = m - 1
          }
        }
        el = words[Math.max(0, idx)].el
      }
      if (el !== last) {
        if (last)
          last.classList.remove('kar-active', 'kar-highlighter', 'kar-underline')
        if (el) {
          el.classList.add('kar-active', styleClass)
          if (followRef.current) el.scrollIntoView({ block: 'center' })
        }
        last = el
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      if (last)
        last.classList.remove('kar-active', 'kar-highlighter', 'kar-underline')
    }
  }, [highlightStyle, indices])

  const markUserScroll = () => {
    if (usePlayerStore.getState().followMode)
      usePlayerStore.getState().setFollow(false)
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        className="recite-scroll h-full overflow-y-auto px-6 py-8"
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
      >
        <div
          className="mx-auto max-w-[42rem] font-[family-name:var(--reader-font,Georgia,'Times_New_Roman',serif)]"
          style={{
            fontSize: 'var(--reader-font-size, 19px)',
            lineHeight: 'var(--reader-line-height, 1.7)',
          }}
        >
          {indices.map((i) => {
            const ds = doc.sections.find((s) => s.idx === i)!
            const ms = manifest.sections.find((s) => s.idx === i)!
            const entry = timeline?.byIndex[i]
            return (
              <SectionView
                key={i}
                docSection={ds}
                manSection={ms}
                sectionStartMs={entry?.startMs ?? 0}
              />
            )
          })}
        </div>
      </div>
      {!follow && (
        <button
          className="btn btn-accent absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg"
          onClick={() => usePlayerStore.getState().setFollow(true)}
          title="Resume following (F)"
        >
          ↓ resume follow
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function SectionView({
  docSection,
  manSection,
  sectionStartMs,
}: {
  docSection: DocSection
  manSection: ManifestSection
  sectionStartMs: number
}) {
  const chunksByPara = useMemo(() => {
    const m = new Map<number, ManifestChunk[]>()
    for (const c of manSection.chunks) {
      const arr = m.get(c.para)
      if (arr) arr.push(c)
      else m.set(c.para, [c])
    }
    return m
  }, [manSection])

  const generating = manSection.status !== 'ready'

  return (
    <section className="mb-10" data-section={docSection.idx}>
      {(docSection.title || manSection.title) && (
        <h2 className="mb-4 font-semibold" style={{ fontSize: '1.3em' }}>
          {docSection.title || manSection.title}
          {generating && (
            <span
              className="kar-chip ml-2 align-middle text-xs"
              title="audio generating — text is readable, synced highlighting starts when the section is done"
            >
              generating…
            </span>
          )}
        </h2>
      )}
      {docSection.paragraphs.map((p) => (
        <ParagraphView
          key={p.idx}
          para={p}
          chunks={chunksByPara.get(p.idx) ?? []}
          sectionStartMs={sectionStartMs}
        />
      ))}
    </section>
  )
}

function ParagraphView({
  para,
  chunks,
  sectionStartMs,
}: {
  para: DocParagraph
  chunks: ManifestChunk[]
  sectionStartMs: number
}) {
  const nodes: React.ReactNode[] = []
  let anyPending = false
  let gi = 0

  const isPunct = (t: string) =>
    /^[,.;:!?)\]}'"’”]/.test(t)
  let prevToken: string | null = null
  const pushToken = (
    token: string,
    timing: { s: number; e: number; w: number } | null,
    chunkIdx: number,
    wordIdx: number,
    pending: boolean,
  ) => {
    if (pending) anyPending = true
    if (nodes.length && !(prevToken === null || isPunct(token)))
      nodes.push(' ')
    prevToken = token
    const cls = `kw${pending ? ' kar-queued' : ''}`
    if (timing) {
      nodes.push(
        <span
          key={gi++}
          className={cls}
          data-s={sectionStartMs + timing.s}
          data-e={sectionStartMs + timing.e}
          data-w={timing.w}
          data-chunk={chunkIdx}
        >
          {token}
        </span>,
      )
    } else {
      nodes.push(
        <span key={gi++} className={cls} data-w-plain="1">
          {token}
        </span>,
      )
    }
  }

  if (chunks.length === 0) {
    // non-TTS paragraph (no_tts, formula marker, pre-TTS): render plain
    for (const s of para.sentences) {
      for (const token of s.words) pushToken(token, null, -1, -1, false)
    }
  } else {
    for (const c of chunks) {
      const ready = c.status === 'ready' && !!c.words
      if (!ready) anyPending = true
      const [a, b] = c.sentence_range
      let k = 0
      for (const s of para.sentences) {
        if (s.idx < a || s.idx > b) continue
        for (const token of s.words) {
          const t = ready ? c.words![k++] ?? null : null
          pushToken(token, t, c.idx, k - 1, !ready)
        }
      }
    }
  }

  return (
    <p className="mb-4" data-page={para.page ?? undefined} data-no-tts={para.no_tts || undefined}>
      {para.page != null && (
        <span
          className="mr-2 select-none text-xs align-baseline"
          style={{ color: 'var(--muted)' }}
          title={`page ${para.page}`}
        >
          {para.page}
        </span>
      )}
      {nodes}
      {anyPending && (
        <span className="sr-only"> (audio generating)</span>
      )}
    </p>
  )
}
