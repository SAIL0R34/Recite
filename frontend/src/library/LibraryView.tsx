import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { BookSummary } from '../types'
import { useLibraryStore } from '../stores/libraryStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useFlightStore } from '../stores/flightStore'
import { startBookFlight } from '../motion'
import { praise } from '../PraiseConfetti'
import { sectionBooks } from './shelf'
import Bookcase from './Bookcase'
import ShelfLabel from './ShelfLabel'
import AddBookDialog from './AddBookDialog'

export default function LibraryView() {
  const books = useLibraryStore((s) => s.books)
  const loading = useLibraryStore((s) => s.loading)
  const error = useLibraryStore((s) => s.error)
  const dialogOpen = useLibraryStore((s) => s.dialogOpen)
  const openDialog = useLibraryStore((s) => s.openDialog)
  const adding = useLibraryStore((s) => s.adding)
  const navigate = useNavigate()
  const animOn = useSettingsStore((s) => s.settings?.pageAnimations === true)

  // two-step selection: first click presents, second opens (flight)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const [perRow, setPerRow] = useState(8)
  const caseRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void useLibraryStore.getState().refresh()
  }, [])

  // While any book is still generating narration, refresh the list so it
  // migrates between shelves as parts complete.
  const generating = books.some(
    (b) => b.generation && b.generation.ready < b.generation.total,
  )
  useEffect(() => {
    if (!generating) return
    const t = setInterval(() => void useLibraryStore.getState().refresh(), 4000)
    return () => clearInterval(t)
  }, [generating])

  const hero = useMemo(
    () =>
      books
        .filter((b) => (b.percent ?? 0) > 0 && b.last_read)
        .sort((a, b) => (b.last_read! - a.last_read!))[0],
    [books],
  )
  const sections = useMemo(() => sectionBooks(books), [books])
  const flat = useMemo(() => sections.flatMap((s) => s.books), [sections])
  const presented = books.find((b) => b.id === selectedId)
  // while a cover lifts off the shelf, the library recedes behind the scrim
  const flightActive = useFlightStore((s) => s.active)

  const bookEl = (id: string) =>
    caseRef.current?.querySelector<HTMLButtonElement>(
      `[data-book-id="${CSS.escape(id)}"]`,
    )
  const frontEl = (id: string) =>
    caseRef.current?.querySelector(
      `[data-book-id="${CSS.escape(id)}"] .book-front`,
    )

  const select = useCallback((id: string) => {
    setSelectedId(id)
    const el = bookEl(id)
    el?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    el?.focus()
  }, [])

  const clear = useCallback(() => setSelectedId(null), [])

  /**
   * Open a book to read. When given an element (hero thumb) it flies from
   * there; when null (stage Read button) it flies from the presented book's
   * front face — snapping the 3D pose flat for one frame so the flight
   * measures an honest rect. The overlay's clone hides the snap.
   */
  const open = useCallback(
    (book: BookSummary, el: Element | null) => {
      const go = () => navigate(`/book/${encodeURIComponent(book.id)}`)
      const front = el ?? (selectedId === book.id ? frontEl(book.id) : null)
      if (!animOn) {
        go()
        return
      }
      const launch = () => {
        const src = front ?? frontEl(book.id) ?? null
        praise(src) // confetti as the book lifts off to be read
        if (!startBookFlight(src, book)) go()
        setLaunchingId(null)
      }
      if (!el && selectedId === book.id) {
        setLaunchingId(book.id)
        requestAnimationFrame(launch)
      } else {
        launch()
      }
    },
    [animOn, navigate, selectedId],
  )

  const onKeydown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (flat.length === 0) return
    const i = selectedId ? flat.findIndex((b) => b.id === selectedId) : -1
    const moveTo = (idx: number) =>
      select(flat[Math.max(0, Math.min(flat.length - 1, idx))].id)
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        moveTo(i < 0 ? 0 : (i + 1) % flat.length)
        break
      case 'ArrowLeft':
        e.preventDefault()
        moveTo(i < 0 ? flat.length - 1 : (i - 1 + flat.length) % flat.length)
        break
      case 'ArrowDown':
        e.preventDefault()
        moveTo(i < 0 ? 0 : i + perRow)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveTo(i < 0 ? 0 : i - perRow)
        break
      case 'Home':
        e.preventDefault()
        moveTo(0)
        break
      case 'End':
        e.preventDefault()
        moveTo(flat.length - 1)
        break
      case 'Escape':
        if (selectedId) {
          e.preventDefault()
          clear()
        }
        break
    }
  }

  return (
    <div className="recite-scroll h-full overflow-y-auto">
      <div
        className={`mx-auto max-w-6xl px-6 pb-10 pt-8${
          flightActive ? ' library-recede' : ''
        }`}
      >
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <p className="kicker mb-1">
              Your library · {books.length} book{books.length === 1 ? '' : 's'}
            </p>
            <h1
              className="text-[32px] font-medium leading-none tracking-tight"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              The Bookcase
            </h1>
          </div>
          <button className="btn btn-accent" onClick={openDialog}>
            + Add book
          </button>
        </div>

        {error && (
          <div
            className="mb-4 rounded-lg border p-3 text-sm"
            style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}
          >
            Backend unreachable: {error}
          </div>
        )}

        {loading && books.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>Loading…</div>
        ) : books.length === 0 ? (
          <div className="flex flex-col items-center gap-6 py-16 text-center">
            <div className="shelf-plank w-full max-w-md" aria-hidden="true" />
            <div className="card flex flex-col items-center gap-4 p-12">
              <p style={{ color: 'var(--muted)' }}>
                Your library is empty. Add a PDF or EPUB from{' '}
                <code>~/Documents/BOOKS</code>.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button className="btn btn-accent" onClick={openDialog}>
                  + Add your first book
                </button>
                <button
                  className="btn"
                  disabled={adding}
                  onClick={() => void useLibraryStore.getState().addSample()}
                >
                  {adding ? 'Adding…' : 'Try the sample book'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <Bookcase
            books={books}
            selectedId={selectedId}
            launchingId={launchingId}
            rootRef={caseRef}
            onKeyDown={onKeydown}
            onSelect={select}
            onOpen={(id) => {
              const book = books.find((b) => b.id === id)
              if (book) open(book, null)
            }}
            onPerRow={setPerRow}
          />
        )}

        {books.length > 0 && (
          <footer
            className="mt-14 flex flex-col items-start gap-2 border-t pt-8 sm:flex-row sm:items-center sm:justify-between"
            style={{ borderColor: 'var(--hairline)' }}
          >
            <div>
              <h2
                className="text-lg italic"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Something missing?
              </h2>
              <p className="mt-0.5 text-sm" style={{ color: 'var(--muted)' }}>
                Add a PDF or EPUB from <code>~/Documents/BOOKS</code>.
              </p>
            </div>
            <button className="btn" onClick={openDialog}>
              + Add a book
            </button>
          </footer>
        )}
      </div>

      <ShelfLabel
        hero={hero}
        presented={presented}
        onOpen={open}
        onClear={clear}
      />
      {dialogOpen && <AddBookDialog />}
    </div>
  )
}
