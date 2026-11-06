import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { BookSummary } from '../types'
import { coverUrl } from '../api/client'
import { floatDelay, restTilt, spineScale, spineTint, spineWidth } from './shelf'
import type { SpineSlot } from './shelf'
import { sampleCoverTint } from './spineColor'

interface ShelfBookProps {
  book: BookSummary
  presented: boolean
  /** one frame where the 3D pose is stripped so the flight can measure */
  launching: boolean
  /** roving tabindex: the presented book, or the first book when none is */
  tabbable: boolean
  /** assorted pose from assortSpines; hash fallbacks apply when absent */
  slot?: SpineSlot
  onSelect: () => void
  onOpen: () => void
}

/**
 * A book on the shelf, Grokipedia-style: at rest it is a NARROW SPINE
 * (title running vertically, cloth tint, paper foot band); the front
 * cover lives on the same 3D box, turned away. The spine wears the
 * COVER's own hue (muted into cloth range) once sampled, with the
 * assorted slot as the pre-sample pose and the fallback. Presenting
 * rotates the book open and widens its slot — neighbors part to make
 * room — until the full cover faces you wearing its paper band. Second
 * click reads: the flat cover face is the flight origin (found via
 * [data-book-id] .book-cover).
 */
export default function ShelfBook({
  book,
  presented,
  launching,
  tabbable,
  slot,
  onSelect,
  onOpen,
}: ShelfBookProps) {
  const [imgOk, setImgOk] = useState(true)
  const [coverTint, setCoverTint] = useState<string | null>(null)
  const titleRef = useRef<HTMLSpanElement>(null)

  // Long titles condense instead of clipping: step the spine title's font
  // down (10.5px CSS base) until the vertical run fits the book's height.
  // Measured, not estimated — glyph metrics and per-book heights vary.
  // Layout effect: fitted before first paint, so no clipped flash. Below
  // the floor the CSS ellipsis is the last resort.
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.fontSize = ''
    let size = 10.5
    while (size > 6.5 && el.scrollHeight > el.clientHeight + 1) {
      size -= 0.5
      el.style.fontSize = `${size}px`
    }
  }, [book.title])
  const gen = book.generation
  const generating = gen != null && gen.ready < gen.total
  const pct = Math.max(0, Math.min(100, book.percent ?? 0))

  // The spine matches the real cover where the cover has a definable hue;
  // grayscale/missing covers keep their assorted cloth (sample resolves
  // null, cached, so nothing re-samples).
  useEffect(() => {
    if (!imgOk) {
      setCoverTint(null)
      return
    }
    let live = true
    void sampleCoverTint(book.id, coverUrl(book.id)).then((t) => {
      if (live) setCoverTint(t)
    })
    return () => {
      live = false
    }
  }, [book.id, imgOk])

  const scene = {
    '--tint': coverTint ?? slot?.cloth ?? spineTint(book.title),
    '--float-delay': slot?.floatDelay ?? floatDelay(book.title),
    '--spine-scale': String(slot?.scale ?? spineScale(book.title)),
    '--rest-tilt': slot?.tilt ?? restTilt(book.title),
    '--spine-w': `${slot?.width ?? spineWidth(book.title)}px`,
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
          {/* the spine the world sees at rest */}
          <span className="book-face book-spine">
            <span ref={titleRef} className="book-spine-title">
              {book.title}
            </span>
            <span className="book-spine-band" />
          </span>
          {/* page-block top edge; warm gilt wash while narration generates */}
          <span className="book-face book-top" />
          {/* page-block bottom + fore-edge — close the box so the mid-swing
              wedge between spine and cover never reads hollow */}
          <span className="book-face book-bottom" />
          <span className="book-face book-fore" />
          {/* the full cover, swung open on presentation */}
          <span className="book-face book-cover">
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
            <span className="book-sheen" />
          </span>
        </span>
      </span>
      <span className="book-shadow" aria-hidden="true" />
    </button>
  )
}
