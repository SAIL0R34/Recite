import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BookDocument,
  DocParagraph,
  DocSection,
  Highlight,
  Manifest,
  ManifestSection,
  ManifestChunk,
} from '../types'
import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useHighlightStore } from '../stores/highlightStore'
import type { Timeline } from '../player/timeline'

const MARK_COLORS = ['amber', 'green', 'sky', 'rose'] as const

// Light the active word this many ms *before* its aligned onset. Forced-
// timestamps mark the exact spoken start, which is already a beat late for
// the eye — a small lead makes the highlight feel synchronous (or slightly
// ahead, as native karaoke readers do).
const LEAD_MS = 90

interface WordRef {
  el: HTMLElement
  s: number
}

interface Menu {
  x: number
  y: number
  sec: number
  para: number
  start: number
  end: number
  text: string
}

/**
 * Karaoke text pane. Renders the current document section plus one section
 * of padding each side (state-based manual windowing). Words carry
 * data-s/data-e (GLOBAL ms), data-w and data-chunk; a single rAF loop
 * binary-searches the flat [data-w] array and toggles one class on the DOM —
 * no React state per frame.
 *
 * Also hosts USER highlights: selecting words pops a color chooser (mouseup
 * delegation); marks persist via useHighlightStore and render back as
 * kar-mark spans keyed by (section, para, token index).
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
  const hlList = useHighlightStore((s) => s.list)
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

  // token index -> highlight, per section:paragraph
  const hlIndex = useMemo(() => {
    const m = new Map<string, Map<number, Highlight>>()
    for (const h of hlList) {
      const k = `${h.section_idx}:${h.para_idx}`
      let mm = m.get(k)
      if (!mm) m.set(k, (mm = new Map()))
      for (let ti = h.start_ti; ti <= h.end_ti; ti++) mm.set(ti, h)
    }
    return m
  }, [hlList])

  const [menu, setMenu] = useState<Menu | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

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
          if (words[m].s - LEAD_MS <= g) {
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

  // user-highlight interaction: select -> menu; click mark -> remove
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const tokenOf = (n: Node | null): HTMLElement | null => {
      let cur: Node | null = n
      while (cur && cur !== el) {
        if (cur instanceof HTMLElement && cur.dataset.ti) return cur
        cur = cur.parentNode
      }
      return null
    }
    const onMouseUp = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setMenu(null)
        return
      }
      const range = sel.getRangeAt(0)
      const a = tokenOf(range.startContainer)
      const b = tokenOf(range.endContainer)
      if (!a || !b || a.dataset.sec !== b.dataset.sec || a.dataset.para !== b.dataset.para) {
        setMenu(null)
        return // v1: marks live inside one paragraph
      }
      const t1 = Number(a.dataset.ti)
      const t2 = Number(b.dataset.ti)
      const [start, end] = t1 <= t2 ? [t1, t2] : [t2, t1]
      const anchor = t1 <= t2 ? a : b
      const wrap = containerRef.current?.parentElement
      if (!wrap) return
      const r = anchor.getBoundingClientRect()
      const wr = wrap.getBoundingClientRect()
      setMenu({
        x: Math.max(8, r.left - wr.left),
        y: r.top - wr.top - 40,
        sec: Number(a.dataset.sec),
        para: Number(a.dataset.para),
        start,
        end,
        text: sel.toString().slice(0, 240),
      })
    }
    const onClick = (e: MouseEvent) => {
      const t = (e.target as HTMLElement).closest?.('[data-hl]')
      if (t) void useHighlightStore.getState().remove(t.getAttribute('data-hl')!)
    }
    el.addEventListener('mouseup', onMouseUp)
    el.addEventListener('click', onClick)
    return () => {
      el.removeEventListener('mouseup', onMouseUp)
      el.removeEventListener('click', onClick)
    }
  }, [])

  const applyMark = (color: string) => {
    if (!menu) return
    void useHighlightStore.getState().add({
      section_idx: menu.sec,
      para_idx: menu.para,
      start_ti: menu.start,
      end_ti: menu.end,
      color,
      text: menu.text,
    })
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        className="recite-scroll h-full overflow-y-auto px-3 py-6 sm:px-6 sm:py-8"
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
                hlIndex={hlIndex}
              />
            )
          })}
        </div>
      </div>
      {menu && (
        <div
          ref={menuRef}
          className="kar-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {MARK_COLORS.map((c) => (
            <button
              key={c}
              className={`kar-menu-swatch kar-menu-${c}`}
              title={`highlight (${c}) — click a marked passage to remove`}
              onClick={() => applyMark(c)}
            />
          ))}
          <button
            className="kar-menu-close"
            onClick={() => {
              window.getSelection()?.removeAllRanges()
              setMenu(null)
            }}
            title="dismiss"
          >
            ✕
          </button>
        </div>
      )}
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
  hlIndex,
}: {
  docSection: DocSection
  manSection: ManifestSection
  sectionStartMs: number
  hlIndex: Map<string, Map<number, Highlight>>
}) {
  // A section with ten thousand chunks (extraction went wrong once) must
  // still open: render a growing window instead of freezing the tab.
  const CAP = 300
  const [limit, setLimit] = useState(CAP)
  useEffect(() => setLimit(CAP), [manSection.idx])
  const more = manSection.chunks.length > limit
  // chunks streaming in via SSE: grey -> black without a manifest refetch
  const chunkDone = usePlayerStore((s) => s.chunkDone[manSection.idx])
  const doneSet = useMemo(() => new Set(chunkDone ?? []), [chunkDone])
  const chunksByPara = useMemo(() => {
    const m = new Map<number, ManifestChunk[]>()
    for (const c of more ? manSection.chunks.slice(0, limit) : manSection.chunks) {
      const arr = m.get(c.para)
      if (arr) arr.push(c)
      else m.set(c.para, [c])
    }
    return m
  }, [manSection, more, limit])

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
      {(() => {
        let lastPara = -1
        chunksByPara.forEach((cs, k) => {
          if (cs.length) lastPara = Math.max(lastPara, k)
        })
        return docSection.paragraphs.slice(0, lastPara + 1)
      })().map((p) => (
        <ParagraphView
          key={p.idx}
          para={p}
          chunks={chunksByPara.get(p.idx) ?? []}
          sectionStartMs={sectionStartMs}
          sectionId={docSection.idx}
          doneSet={doneSet}
          marks={hlIndex.get(`${docSection.idx}:${p.idx}`)}
        />
      ))}
      {more && (
        <button
          className="btn btn-sm"
          onClick={() => setLimit((l) => l + CAP * 2)}
        >
          … {(manSection.chunks?.length ?? 0) - limit} more chunks — show more
        </button>
      )}
    </section>
  )
}

function ParagraphView({
  para,
  chunks,
  doneSet = new Set<number>(),
  sectionStartMs,
  sectionId,
  marks,
}: {
  para: DocParagraph
  chunks: ManifestChunk[]
  sectionStartMs: number
  sectionId: number
  doneSet?: Set<number>
  marks?: Map<number, Highlight>
}) {
  const nodes: React.ReactNode[] = []
  let anyPending = false
  let gi = 0
  let ti = 0 // token index within paragraph — the highlight anchor

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
    const mark = marks?.get(ti)
    let cls = `kw${pending ? ' kar-queued' : ''}`
    if (mark) cls += ` kar-mark kar-mark-${mark.color}`
    const tiHere = ti++
    const attrs = {
      'data-sec': sectionId,
      'data-para': para.idx,
      'data-ti': tiHere,
      ...(mark ? { 'data-hl': mark.id } : {}),
    }
    if (timing) {
      nodes.push(
        <span
          key={gi++}
          className={cls}
          data-s={sectionStartMs + timing.s}
          data-e={sectionStartMs + timing.e}
          data-w={timing.w}
          data-chunk={chunkIdx}
          {...attrs}
        >
          {token}
        </span>,
      )
    } else {
      nodes.push(
        <span key={gi++} className={cls} data-w-plain="1" {...attrs}>
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
      const done = ready || doneSet.has(c.idx)
      if (!done) anyPending = true
      const [a, b] = c.sentence_range
      let k = 0
      for (const s of para.sentences) {
        if (s.idx < a || s.idx > b) continue
        for (const token of s.words) {
          const t = ready ? c.words![k++] ?? null : null
          pushToken(token, t, c.idx, k - 1, !done)
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
