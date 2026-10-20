import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type { BookSummary } from '../types'
import { SHELF_GAP, chunk, sectionBooks } from './shelf'
import ShelfBook from './ShelfBook'

interface BookcaseProps {
  books: BookSummary[]
  selectedId: string | null
  launchingId: string | null
  rootRef: RefObject<HTMLDivElement>
  /** the keyboard handler lives in LibraryView (it owns the flat index) */
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onPerRow: (n: number) => void
}

/**
 * The bookcase: sections of shelf rows, one continuous wooden plank per row.
 * Row occupancy is measured, not configured — a ResizeObserver reads the
 * first scene's width and the container's, so any viewport wraps correctly.
 */
export default function Bookcase({
  books,
  selectedId,
  launchingId,
  rootRef,
  onKeyDown,
  onSelect,
  onOpen,
  onPerRow,
}: BookcaseProps) {
  const [perRow, setPerRow] = useState(8)
  const sections = sectionBooks(books)
  const firstId = sections[0]?.books[0]?.id

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => {
      const scene = root.querySelector<HTMLElement>('.book-scene')
      if (!scene) return
      const slot = scene.offsetWidth + SHELF_GAP
      if (slot > 0) {
        const n = Math.max(1, Math.floor((root.clientWidth + SHELF_GAP) / slot))
        setPerRow((prev) => (prev === n ? prev : n))
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    return () => ro.disconnect()
  }, [rootRef, books.length])

  useEffect(() => onPerRow(perRow), [perRow, onPerRow])

  return (
    <div ref={rootRef} className="bookcase" onKeyDown={onKeyDown}>
      {sections.map((s) => (
        <section key={s.key} aria-label={s.label} className="shelf-section">
          <div className="shelf-heading">
            <span className="kicker">{s.label}</span>
            <span className="shelf-rule" aria-hidden="true" />
            <span className="kicker shelf-count">{s.books.length}</span>
          </div>
          {chunk(s.books, perRow).map((row, i) => (
            <div className="shelf-row" key={i}>
              <div className="shelf-books">
                {row.map((b) => (
                  <ShelfBook
                    key={b.id}
                    book={b}
                    presented={b.id === selectedId}
                    launching={b.id === launchingId}
                    tabbable={b.id === selectedId || (!selectedId && b.id === firstId)}
                    onSelect={() => onSelect(b.id)}
                    onOpen={() => onOpen(b.id)}
                  />
                ))}
              </div>
              <div className="shelf-plank" aria-hidden="true" />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
