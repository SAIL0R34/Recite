import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useHighlightStore } from '../stores/highlightStore'
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
  // Text-first: the document alone paints prose instantly (stub manifest);
  // the slim manifest (no word timings) follows and upgrades the UI.
  useEffect(() => {
    let dead = false
    setError(null)
    setDoc(null)
    setManifest(null)
    void (async () => {
      try {
        const docP = getDocument(bookId)
        const slimP = getManifest(bookId, { slim: true })
        const refreshP = useLibraryStore
          .getState()
          .refresh().then(() => undefined)
        void docP.then((d) => {
          if (!dead && !manifest) {
            setDoc(d)
            setManifest(stubManifest(d))
          }
        }).catch(() => { /* main try/catch below reports it */ })
        const [d, m] = await Promise.all([docP, slimP, refreshP])
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

  // Ready sections render without word data (slim manifest); fetch timings
  // for the visible trio so highlighting works. Cheap: one section ~50 KB.
  const sectionIdx = store.sectionIdx
  useEffect(() => {
    if (!manifest) return
    for (const i of [sectionIdx - 1, sectionIdx, sectionIdx + 1]) {
      const s = manifest.sections.find((x) => x.idx === i)
      if (s && s.status === "ready" && !(s.chunks?.[0]?.words?.length))
        void usePlayerStore.getState().ensureTimings(i).then((merged) => {
          // mirror into local state so TextPane re-renders words with data-s
          if (merged) setManifest((cur) => (cur === manifest ? merged : cur))
        })
    }
  }, [manifest, sectionIdx])

  // user highlights for this book
  useEffect(() => {
    void useHighlightStore.getState().refresh(bookId)
  }, [bookId])

  // Chapter jump: scroll the newly-rendered section to the top once React
  // has committed it (a beat of timeout is enough for the ±1 window).
  const jump = store.jump
  useEffect(() => {
    if (!jump) return
    const t = setTimeout(() => {
      document
        .querySelector(`[data-section="${jump.idx}"]`)
        ?.scrollIntoView({ block: 'start' })
    }, 60)
    return () => clearTimeout(t)
  }, [jump])

  // The TTS window follows the cursor (budget + grace live server-side);
  // idempotent and cheap for fully-ready books.
  useEffect(() => {
    const t = setTimeout(() => {
      void requestGeneration(bookId, store.sectionIdx).catch(() => undefined)
    }, 2500)
    return () => clearTimeout(t)
  }, [store.sectionIdx])

  // ---- SSE + polling fallback -------------------------------------------
  useEffect(() => {
    if (!manifest) return
    let lastReady = -1
    let chunkTick = 0
    const reload = async () => {
      try {
        const m = await getManifest(bookId, { slim: true })
        setManifest(m)
        usePlayerStore.getState().setManifest(m)
      } catch {
        /* transient */
      }
    }
    const off = subscribeToBookEvents(bookId, {
      onSection: (e) => {
        if (e.status === 'ready')
          usePlayerStore.getState().clearChunkDone(e.idx)
        void reload()
      },
      onChunk: (e) => {
        usePlayerStore.getState().noteChunk(e.idx, e.chunk)
        // partial audio growing under the playhead: refresh periodically
        // and let the engine continue a parked partial section
        if (e.idx === engine.sectionIdx && ++chunkTick > 10) {
          chunkTick = 0
          void reload().then(() => void engine.resumeWaiting())
        }
      },
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

  // ---- auto-hiding transport --------------------------------------------
  // The bar slides away after a few idle seconds; a tap, a key, or the
  // cursor entering the bottom edge reveals it again (scrolling
  // deliberately does not). :focus-within pins it while a control is used.
  const [barVisible, setBarVisible] = useState(true)
  const barTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pokeBar = useCallback(() => {
    setBarVisible(true)
    if (barTimer.current) clearTimeout(barTimer.current)
    barTimer.current = setTimeout(() => setBarVisible(false), 4500)
  }, [])
  const pauseBarHide = useCallback(() => {
    if (barTimer.current) clearTimeout(barTimer.current)
  }, [])
  useEffect(() => {
    const events = ['pointerdown', 'keydown'] as const
    // On touch the *only* reveal path is the explicit pill button — taps and
    // swipes must not reveal (their pointerdown/pointermove are filtered by
    // pointerType). Mouse and keyboard reveal as usual; scrolling never does.
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') pokeBar()
    }
    events.forEach((e) =>
      window.addEventListener(
        e,
        e === 'pointerdown' ? (onPointer as EventListener) : pokeBar,
        { passive: true },
      ),
    )
    // hovering the bottom edge — where the bar lives — reveals it
    const onMove = (e: PointerEvent) => {
      if (
        (e.pointerType === 'mouse' || e.pointerType === 'pen') &&
        e.clientY > window.innerHeight - 110
      )
        pokeBar()
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    pokeBar()
    return () => {
      events.forEach((e) => window.removeEventListener(e, pokeBar))
      window.removeEventListener('pointermove', onMove)
      if (barTimer.current) clearTimeout(barTimer.current)
    }
  }, [pokeBar])

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
      // save whenever the position moved — also while paused, so a
      // click-to-seek or pause position survives a refresh
      if (dirtyRef.current) void save()
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
  if (!doc || !manifest)
    return (
      <div className="p-8 text-sm" style={{ color: 'var(--muted)' }}>
        Opening…
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* hero */}
      <div
        className="sticky top-0 z-20 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:gap-4 sm:px-5 sm:py-3"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
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
        {timeline && <ChapterMenu timeline={timeline} />}
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

      {timeline && (
        <div
          className={`transport-shell${barVisible ? '' : ' transport-hidden'}`}
          onPointerEnter={pauseBarHide}
          onPointerLeave={pokeBar}
        >
          <TransportBar
            timeline={timeline}
            onToggleBookmarks={() => setDrawerOpen((v) => !v)}
          />
        </div>
      )}

      {/* touch devices have no hover zone — give them an explicit reveal
          pill when the bar auto-hid */}
      <button
        className={`reveal-btn${barVisible ? ' reveal-hidden' : ''}`}
        onClick={pokeBar}
        title="Show playback controls"
        aria-label="Show playback controls"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             strokeWidth="1.9" strokeLinecap="round" aria-hidden focusable="false">
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
          <circle cx="9" cy="7" r="2.4" fill="var(--accent)" stroke="none" />
          <circle cx="15" cy="12" r="2.4" fill="var(--accent)" stroke="none" />
          <circle cx="9" cy="17" r="2.4" fill="var(--accent)" stroke="none" />
        </svg>
      </button>
    </div>
  )
}

/** Manifest stand-in built from the document alone, so prose paints before
 *  the (slim) manifest arrives; every section reads as pending. */
function stubManifest(doc: BookDocument): Manifest {
  return {
    engine: '',
    voice: '',
    alignment: 'interp',
    sections: doc.sections.map((s) => ({
      idx: s.idx,
      title: s.title ?? '',
      audio: '',
      duration_ms: 0,
      status: 'pending',
      chunks: [],
    })),
  }
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
