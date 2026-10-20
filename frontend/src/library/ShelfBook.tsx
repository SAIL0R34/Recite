import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { BookSummary } from '../types'
import { coverUrl } from '../api/client'
import { floatDelay, spineTint } from './shelf'

interface ShelfBookProps {
  book: BookSummary
  presented: boolean
  /** one frame where the 3D pose is stripped so the flight can measure */
  launching: boolean
  /** roving tabindex: the presented book, or the first book when none is */
  tabbable: boolean
  onSelect: () => void
  onOpen: () => void
}

/**
 * A book standing on a shelf: a pure-CSS 3D box (front cover + spine +
 * page-block top). First click presents it (pull-out + paper band); second
 * click opens it — the front face is the flight origin (found via
 * [data-book-id] .book-front, so no ref plumbing through the tree).
 */
export default function ShelfBook({
  book,
  presented,
  launching,
  tabbable,
  onSelect,
  onOpen,
}: ShelfBookProps) {
  const [imgOk, setImgOk] = useState(true)
  const gen = book.generation
  const generating = gen != null && gen.ready < gen.total
  const pct = Math.max(0, Math.min(100, book.percent ?? 0))
  const scene = {
    '--tint': spineTint(book.title),
    '--float-delay': floatDelay(book.title),
  } as CSSProperties

  return (
    <button
      type="button"
      data-book-id={book.id}
      className={
        'book-scene' +
        (presented ? ' is-presented' : '') +
        (launching ? ' is-launching' : '') +
        (generating ? ' is-generating' : '')
      }
      style={scene}
      tabIndex={tabbable ? 0 : -1}
      aria-current={presented || undefined}
      aria-label={
        `${book.title}${book.author ? ` by ${book.author}` : ''}` +
        `, ${Math.round(pct)}% read` +
        (generating ? ', generating narration' : '') +
        (presented ? ', presented — activate again to read' : '')
      }
      onClick={presented ? onOpen : onSelect}
    >
      <span className="book-bob" aria-hidden="true">
        <span className="book">
          <span className="book-face book-front">
            {imgOk ? (
              <img
                className="book-img"
                src={coverUrl(book.id)}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => setImgOk(false)}
              />
            ) : (
              <span className="book-typo">
                <span className="book-typo-title">{book.title}</span>
                {book.author && (
                  <span className="book-typo-author">{book.author}</span>
                )}
              </span>
            )}
            {pct > 0 && (
              <span
                className="book-ribbon"
                style={{ height: `clamp(8%, ${pct}%, 88%)` }}
              />
            )}
            {presented && <span className="book-band" />}
            <span className="book-sheen" />
          </span>
          <span className="book-face book-spine">
            <span className="book-spine-title">{book.title}</span>
            <span className="book-spine-band" />
          </span>
          <span className="book-face book-top" />
        </span>
      </span>
      <span className="book-shadow" aria-hidden="true" />
    </button>
  )
}
