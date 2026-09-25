import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { requestGeneration } from '../api/client'
import type { Timeline } from '../player/timeline'
import { clampPage, pageCountFor, pageForX, sectionForPage } from './paged'
import type { PageGeom, SectionPageBound } from './paged'

const MARK_COLORS = ['amber', 'green', 'sky', 'rose'] as const

// Paged mode: the section window is laid out as a horizontal multi-column
// strip (one column = one page) and the visible page is a track translate.
const PAGE_GAP = 48
const PAGE_MARGIN = 24

type PageAnchor =
  | { kind: 'word'; sec: number; para: number; ti: number }
  | { kind: 'section'; sec: number }

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
  const jump = usePlayerStore((s) => s.jump)
  const highlightStyle = useSettingsStore(
    (s) => s.settings?.highlightStyle ?? 'highlighter',
  )
  const paged = useSettingsStore((s) => s.settings?.readingMode === 'paged')
  const hlList = useHighlightStore((s) => s.list)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const wordsRef = useRef<WordRef[]>([])
  const followRef = useRef(follow)
  followRef.current = follow

  // ---- paged-mode state (all reads via refs so closures stay valid) ----
  const trackRef = useRef<HTMLDivElement | null>(null)
  const colsRef = useRef<HTMLDivElement | null>(null)
  const [page, setPage] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [pageW, setPageW] = useState(0)
  const pageRef = useRef(0)
  pageRef.current = page
  const pageCountRef = useRef(1)
  pageCountRef.current = pageCount
  const pageWRef = useRef(0)
  pageWRef.current = pageW
  const pagedRef = useRef(paged)
  pagedRef.current = paged
  const secBoundsRef = useRef<SectionPageBound[]>([])
  const pendingAnchorRef = useRef<PageAnchor | null>(null)
  const swipeRef = useRef<{ x: number; y: number } | null>(null)

  const geom = (): PageGeom => ({ pageW: pageWRef.current, gap: PAGE_GAP })

  /**
   * Page of a DOM node via rect difference against the columns box. NOT
   * offsetLeft: engines disagree on column-relative offsets for fragments.
   * The track translate shifts both rects identically, so this is
   * transform-invariant (safe mid-turn).
   */
  const pageOfEl = (el: HTMLElement): number => {
    const cols = colsRef.current
    if (!cols || pageWRef.current <= 0) return 0
    const r = el.getBoundingClientRect()
    const c = cols.getBoundingClientRect()
    return pageForX(r.left - c.left, geom())
  }

  const remeasure = () => {
    const cols = colsRef.current
    if (!cols || pageWRef.current <= 0) return
    // overflow:hidden boxes are still programmatically scrollable — a stray
    // scroll would desync the transform, so pin it
    if (containerRef.current) containerRef.current.scrollTop = 0
    const c = cols.getBoundingClientRect()
    const bounds: SectionPageBound[] = []
    let strip = 0
    for (const s of Array.from(cols.querySelectorAll<HTMLElement>('[data-section]'))) {
      const r = s.getBoundingClientRect()
      const left = r.left - c.left
      if (left >= 0)
        bounds.push({ sec: Number(s.dataset.section), page: pageForX(left, geom()) })
      strip = Math.max(strip, r.right - c.left)
    }
    secBoundsRef.current = bounds
    const count = pageCountFor(strip, geom())
    setPageCount(count)
    // a window slide renumbered the pages — land back on the anchor
    const a = pendingAnchorRef.current
    if (a) {
      const sel =
        a.kind === 'word'
          ? `[data-sec="${a.sec}"][data-para="${a.para}"][data-ti="${a.ti}"]`
          : `[data-section="${a.sec}"]`
      const el = cols.querySelector(sel) as HTMLElement | null
      if (el) {
        pendingAnchorRef.current = null
        setPage(clampPage(pageOfEl(el), count))
        return
      }
    }
    setPage((p) => clampPage(p, count))
  }

  const firstWordOnPage = (target: number): PageAnchor | null => {
    const cols = colsRef.current
    if (!cols) return null
    const c = cols.getBoundingClientRect()
    const step = pageWRef.current + PAGE_GAP
    for (const w of Array.from(cols.querySelectorAll<HTMLElement>('[data-para]'))) {
      const x = w.getBoundingClientRect().left - c.left
      if (x >= target * step - step / 2 && x < (target + 1) * step - step / 2)
        return {
          kind: 'word',
          sec: Number(w.dataset.sec),
          para: Number(w.dataset.para),
          ti: Number(w.dataset.ti),
        }
    }
    return null
  }

  const goToPage = (target: number, manual: boolean) => {
    const t = clampPage(target, pageCountRef.current)
    if (manual && followRef.current) usePlayerStore.getState().setFollow(false)
    const sec = sectionForPage(secBoundsRef.current, t)
    if (sec !== usePlayerStore.getState().sectionIdx) {
      // crossing into another section promotes it — the ±1 window slides and
      // pages renumber; the anchor restores the position after remeasure
      pendingAnchorRef.current = firstWordOnPage(t) ?? { kind: 'section', sec }
      usePlayerStore.setState({ sectionIdx: sec })
    }
    setPage(t)
  }

  const flip = (delta: number) => {
    const target = pageRef.current + delta
    if (target < 0 || target > pageCountRef.current - 1) {
      // strip edge: advance the section window (v1: lands on section start)
      const st = usePlayerStore.getState()
      const nextIdx = st.sectionIdx + delta
      if (st.manifest?.sections.some((s) => s.idx === nextIdx)) {
        pendingAnchorRef.current = { kind: 'section', sec: nextIdx }
        if (followRef.current) usePlayerStore.getState().setFollow(false)
        usePlayerStore.setState({ sectionIdx: nextIdx })
      }
      return
    }
    goToPage(target, true)
  }

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
          if (followRef.current) {
            if (pagedRef.current) {
              // narration auto-flip: follow the spoken word across pages
              const p = pageOfEl(el)
              if (p !== pageRef.current) setPage(p)
            } else {
              el.scrollIntoView({ block: 'center' })
            }
          }
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
    if (pagedRef.current) return // wheel does nothing in paged mode
    if (usePlayerStore.getState().followMode)
      usePlayerStore.getState().setFollow(false)
  }

  // ---- paged geometry: derive page width, then re-measure every render ---
  // (renders are the only way the column DOM changes: window slides, SSE
  // chunk updates, CAP expansion — so a per-render pass covers them all)
  useEffect(() => {
    const el = containerRef.current
    if (!paged || !el) return
    const compute = () => {
      const margin = el.clientWidth < 640 ? 12 : PAGE_MARGIN
      setPageW(Math.max(200, Math.min(672, el.clientWidth - 2 * margin)))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [paged])

  useLayoutEffect(() => {
    if (!paged) return
    remeasure()
    document.fonts?.ready?.then(() => remeasure()).catch(() => undefined)
  })

  // chapter jumps (jumpToSection nonce) and search reveals arrive as store
  // state / window events — the pane owns all layout navigation
  useEffect(() => {
    if (!jump) return
    const t = setTimeout(() => {
      const el = containerRef.current?.querySelector(`[data-section="${jump.idx}"]`)
      if (!el) return
      if (pagedRef.current) setPage(pageOfEl(el as HTMLElement))
      else el.scrollIntoView({ block: 'start' })
    }, 60)
    return () => clearTimeout(t)
  }, [jump])

  useEffect(() => {
    const onPage = (e: Event) => {
      if (!pagedRef.current) return
      flip((e as CustomEvent).detail.delta)
    }
    const onReveal = (e: Event) => {
      const d = (e as CustomEvent).detail as { sel: string; block: ScrollLogicalPosition }
      const el = containerRef.current?.querySelector(d.sel) as HTMLElement | null
      const p = (el?.closest('p') as HTMLElement | null) ?? el
      if (!p) return
      if (pagedRef.current) setPage(pageOfEl(p))
      else p.scrollIntoView({ block: d.block })
    }
    window.addEventListener('recite:page', onPage)
    window.addEventListener('recite:reveal', onReveal)
    return () => {
      window.removeEventListener('recite:page', onPage)
      window.removeEventListener('recite:reveal', onReveal)
    }
  }, [])

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
      if (t) {
        void useHighlightStore.getState().remove(t.getAttribute('data-hl')!)
        return
      }
      // Click-to-seek: a plain click on a timed word jumps the narration to
      // its onset (data-s is global ms). Selection drags (highlighting) never
      // reach here; words of pending audio have no data-s and no seek.
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return
      const w = (e.target as HTMLElement).closest?.('[data-s]') as HTMLElement | null
      if (!w || !w.classList.contains('kw')) return
      const s = Number(w.dataset.s)
      if (Number.isFinite(s)) usePlayerStore.getState().seek(s)
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

  const sections = indices.map((i) => {
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
  })

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        className={
          paged
            ? 'recite-page h-full pt-6 pb-40 sm:pb-44'
            : 'recite-scroll h-full overflow-y-auto px-3 pb-40 pt-6 sm:px-6 sm:pt-8 sm:pb-44'
        }
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={
          paged
            ? (e) => {
                swipeRef.current = { x: e.clientX, y: e.clientY }
              }
            : undefined
        }
        onPointerUp={
          paged
            ? (e) => {
                const s = swipeRef.current
                swipeRef.current = null
                if (!s) return
                const dx = e.clientX - s.x
                const dy = e.clientY - s.y
                if (Math.abs(dx) > 48 && Math.abs(dx) > 2 * Math.abs(dy))
                  flip(dx < 0 ? 1 : -1)
              }
            : undefined
        }
      >
        {paged ? (
          <div
            ref={trackRef}
            className="page-track mx-auto"
            style={{
              width: pageW || undefined,
              transform: `translateX(${-(page * (pageW + PAGE_GAP))}px)`,
            }}
          >
            <div
              ref={colsRef}
              className="page-cols font-[family-name:var(--reader-font,Georgia,'Times_New_Roman',serif)]"
              style={{
                width: pageW || undefined,
                columnWidth: pageW || undefined,
                columnGap: PAGE_GAP,
                fontSize: 'var(--reader-font-size, 19px)',
                lineHeight: 'var(--reader-line-height, 1.7)',
              }}
            >
              {sections}
            </div>
          </div>
        ) : (
          <div
            className="mx-auto max-w-[42rem] font-[family-name:var(--reader-font,Georgia,'Times_New_Roman',serif)]"
            style={{
              fontSize: 'var(--reader-font-size, 19px)',
              lineHeight: 'var(--reader-line-height, 1.7)',
            }}
          >
            {sections}
          </div>
        )}
      </div>
      {paged && (
        <>
          <button
            className="page-hotspot left-0"
            aria-label="Previous page"
            title="Previous page"
            onClick={() => flip(-1)}
          />
          <button
            className="page-hotspot right-0"
            aria-label="Next page"
            title="Next page"
            onClick={() => flip(1)}
          />
        </>
      )}
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
          className="btn btn-accent absolute bottom-[9.5rem] left-1/2 -translate-x-1/2 shadow-lg"
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
  const failed = manSection.status === 'failed'
  const bookId = usePlayerStore((s) => s.bookId)

  return (
    <section className="mb-10" data-section={docSection.idx}>
      {(docSection.title || manSection.title) && (
        <h2 className="mb-4 font-semibold" style={{ fontSize: '1.3em' }}>
          {docSection.title || manSection.title}
          {failed ? (
            <button
              className="kar-chip kar-chip-static ml-2 align-middle text-xs"
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
              title="Narration for this section failed — click to retry"
              onClick={() => {
                if (bookId) void requestGeneration(bookId, manSection.idx)
              }}
            >
              failed · retry
            </button>
          ) : (
            generating && (
              <span
                className="kar-chip ml-2 align-middle text-xs"
                title="audio generating — text is readable, synced highlighting starts when the section is done"
              >
                generating…
              </span>
            )
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
          sectionReady={manSection.status === 'ready'}
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
  sectionReady,
  marks,
}: {
  para: DocParagraph
  chunks: ManifestChunk[]
  sectionStartMs: number
  sectionId: number
  doneSet?: Set<number>
  /** section audio is ready — slim chunks without timings are NOT dimmed */
  sectionReady: boolean
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
    // Mark lookup BEFORE the space emission: the same-mark peek at ti±1
    // decides whether the inter-word space rides inside this span, so a
    // multi-word mark reads as one continuous highlighter stroke.
    const mark = marks?.get(ti)
    const joinL = !!mark && marks?.get(ti - 1)?.id === mark.id
    const joinR = !!mark && marks?.get(ti + 1)?.id === mark.id
    let text = token
    if (pending) anyPending = true
    if (nodes.length && !(prevToken === null || isPunct(token))) {
      if (joinL) text = ' ' + token // backgrounds abut exactly
      else nodes.push(' ')
    }
    prevToken = token
    let cls = `kw${pending ? ' kar-queued' : ''}`
    if (mark) {
      cls += ` kar-mark kar-mark-${mark.color}`
      if (joinL) cls += ' kar-mark-join-l'
      if (joinR) cls += ' kar-mark-join-r'
    }
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
          {text}
        </span>,
      )
    } else {
      nodes.push(
        <span key={gi++} className={cls} data-w-plain="1" {...attrs}>
          {text}
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
      // A words-less chunk in a ready section only lacks timings (they land
      // via ensureTimings moments later) — it must not flash dim.
      const dim = !done && !sectionReady
      if (dim) anyPending = true
      const [a, b] = c.sentence_range
      let k = 0
      for (const s of para.sentences) {
        if (s.idx < a || s.idx > b) continue
        for (const token of s.words) {
          const t = ready ? c.words![k++] ?? null : null
          pushToken(token, t, c.idx, k - 1, dim)
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
