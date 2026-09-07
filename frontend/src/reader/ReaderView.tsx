import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { BookDocument, Manifest, Progress } from '../types'
import {
  createBookmark,
  getDocument,
  getManifest,
  getProgress,
  getStatus,
  putProgress,
  requestGeneration,
  sendProgressBeacon,
} from '../api/client'
import { sseSupported, subscribeToBookEvents } from '../api/sse'
import { useLibraryStore } from '../stores/libraryStore'
import { usePlayerStore } from '../stores/playerStore'
import { engine } from '../player/engine'
import TextPane from './TextPane'
import TransportBar from './TransportBar'
import ChapterMenu from './ChapterMenu'
import BookmarkDrawer from './BookmarkDrawer'
import AppearancePanel from './AppearancePanel'

export default function ReaderView() {
  const { id } = useParams<{ id: string }>()
  const bookId = id ?? ''
  const book = useLibraryStore((s) => s.books.find((b) => b.id === bookId))

  const [doc, setDoc] = useState<BookDocument | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)

  const store = usePlayerStore()
  const timeline = store.timeline

  // ---- load -----------------------------------------------------------
  useEffect(() => {
    let dead = false
    setError(null)
    setDoc(null)
    setManifest(null)
    void (async () => {
      try {
        const [d, m, books] = await Promise.all([
          getDocument(bookId),
          getManifest(bookId),
          useLibraryStore.getState().refresh().then(() => undefined),
        ])
        if (dead) return
        setDoc(d)
        setManifest(m)
        const percent = useLibraryStore
          .getState()
          .books.find((b) => b.id === bookId)?.percent ?? 0
        await usePlayerStore.getState().load(bookId, d, m, percent)
        const p = await getProgress(bookId)
        if (dead) return
        if (p) usePlayerStore.getState().resumeFrom(p)
        // Nothing spoken yet and the queue idle → start TTS now. Bias: the
        // section in view, unless it's huge (a book's 700-chunk front matter
        // is ~25 min of synthesis) — then the smallest pending section so
        // something becomes audible soon.
        const inflight = ["ready", "synthesizing", "aligning", "encoding"]
        const pending = m.sections.filter((s) => s.status === "pending")
        if (!m.sections.some((s) => inflight.includes(s.status)) && pending.length) {
          const cur = m.sections[usePlayerStore.getState().sectionIdx]
          const boost =
            cur && cur.status === "pending" && (cur.chunks?.length ?? 0) <= 400
              ? cur.idx
              : pending.slice().sort((a, b) => a.chunks.length - b.chunks.length)[0].idx
          void requestGeneration(bookId, boost)
        }
      } catch (e) {
        if (!dead) setError((e as Error).message)
      }
    })()
    return () => {
      dead = true
    }
  }, [bookId])

  // ---- SSE + polling fallback -------------------------------------------
  useEffect(() => {
    if (!manifest) return
    let lastReady = -1
    const reload = async () => {
      try {
        const m = await getManifest(bookId)
        setManifest(m)
        usePlayerStore.getState().setManifest(m)
      } catch {
        /* transient */
      }
    }
    const off = subscribeToBookEvents(bookId, {
      onSection: () => void reload(),
      onGeneration: () => void reload(),
    })
    let timer: ReturnType<typeof setInterval> | null = null
    if (!sseSupported()) {
      timer = setInterval(async () => {
        try {
          const s = await getStatus(bookId)
          if (s.ready !== lastReady) {
            lastReady = s.ready
            await reload()
          }
        } catch {
          /* ignore */
        }
      }, 5000)
    }
    return () => {
      off()
      if (timer) clearInterval(timer)
    }
    // manifest identity intentionally not a dep — effect keyed on id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, !!manifest])

  // ---- progress persistence ----------------------------------------------
  const dirtyRef = useRef(false)
  useEffect(() => {
    const mark = () => (dirtyRef.current = true)
    const unsub = engine.onTick(mark)
    const save = async () => {
      if (!dirtyRef.current) return
      dirtyRef.current = false
      const p = usePlayerStore.getState().currentProgress()
      if (p) await putProgress(bookId, p).catch(() => {})
    }
    const interval = setInterval(() => {
      if (usePlayerStore.getState().playing) void save()
    }, 2000)
    // save on the playing → paused transition (covers pause + ended)
    let wasPlaying = false
    const offState = engine.onState(({ playing }) => {
      if (wasPlaying && !playing) void save()
      wasPlaying = playing
    })
    const leave = () => {
      const p = usePlayerStore.getState().currentProgress()
      if (p) sendProgressBeacon(bookId, p)
    }
    window.addEventListener('pagehide', leave)
    return () => {
      unsub()
      offState()
      clearInterval(interval)
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [bookId])

  // ---- media session -------------------------------------------------------
  useEffect(() => {
    engine.setupMediaSession()
    if (doc)
      engine.setMediaTitle(
        doc.title,
        doc.author || book?.author || 'Recite',
      )
  }, [doc, book])

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable
      )
        return
      const st = usePlayerStore.getState()
      switch (e.key) {
        case ' ':
          e.preventDefault()
          st.toggle()
          break
        case 'ArrowRight':
          e.preventDefault()
          st.seekBy(e.shiftKey ? 60_000 : 10_000)
          break
        case 'ArrowLeft':
          e.preventDefault()
          st.seekBy(e.shiftKey ? -60_000 : -10_000)
          break
        case 'j':
        case 'J':
          st.prevSection()
          break
        case 'l':
        case 'L':
          st.nextSection()
          break
        case 'b':
        case 'B':
          void (async () => {
            const p = st.currentProgress()
            if (!p) return
            const bm = await createBookmark(bookId, {
              name: '',
              section_idx: p.section_idx,
              ms: p.ms_into_section,
            }).catch(() => null)
            if (bm)
              useLibraryStore
                .getState()
                .toast('info', `Bookmarked: “${bm.name || 'passage'}”`)
          })()
          break
        case 'f':
        case 'F':
          st.setFollow(!st.followMode)
          break
        case 'Escape':
          setDrawerOpen(false)
          setAppearanceOpen(false)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bookId])

  const percent = store.percent
  const readyCount = useMemo(
    () => (manifest?.sections ?? []).filter((s) => s.status === 'ready').length,
    [manifest],
  )

  if (error)
    return (
      <div className="p-8">
        <p style={{ color: 'var(--muted)' }}>Couldn't open this book: {error}</p>
        <Link to="/" className="btn mt-4 inline-flex">
          ← library
        </Link>
      </div>
    )
  if (!doc || !manifest || !timeline)
    return (
      <div className="p-8 text-sm" style={{ color: 'var(--muted)' }}>
        Opening…
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* hero */}
      <div
        className="flex shrink-0 items-center gap-4 border-b px-5 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <Link to="/" className="btn btn-ghost btn-sm" title="Library">
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold leading-tight">
            {doc.title}
          </h1>
          <p className="truncate text-xs" style={{ color: 'var(--muted)' }}>
            {doc.author || book?.author}
            {' · '}
            {readyCount}/{manifest.sections.length} sections ready
          </p>
        </div>
        <button
          className="btn btn-accent"
          onClick={() => usePlayerStore.getState().toggle()}
          title="Continue (space)"
        >
          {store.playing ? '⏸ Pause' : '▶ Continue'}
        </button>
        <PercentRing percent={percent} />
        <ChapterMenu timeline={timeline} />
        <button
          className="btn btn-sm"
          onClick={() => setAppearanceOpen((v) => !v)}
        >
          Aa
        </button>
      </div>

      {appearanceOpen && (
        <div className="absolute right-4 top-24 z-30">
          <AppearancePanel />
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <TextPane doc={doc} manifest={manifest} timeline={timeline} />
        <BookmarkDrawer
          bookId={bookId}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onPinned={() => undefined}
        />
      </div>

      <TransportBar
        timeline={timeline}
        onToggleBookmarks={() => setDrawerOpen((v) => !v)}
      />
    </div>
  )
}

function PercentRing({ percent }: { percent: number }) {
  const r = 14
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, percent ?? 0))
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" role="img" aria-label={`${p}% read`}>
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p / 100)}
        transform="rotate(-90 20 20)"
      />
      <text x="20" y="23.5" textAnchor="middle" fontSize="8.5" fill="var(--muted)">
        {Math.round(p)}%
      </text>
    </svg>
  )
}
