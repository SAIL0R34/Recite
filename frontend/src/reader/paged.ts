// Pure pagination math for paged reading mode. The paged layout is a
// horizontal multi-column strip (one column = one page); the visible page
// is a translateX of the track. All functions are layout-DOM-free so they
// are unit-testable and shared by measure/follow/turn code paths.

export interface PageGeom {
  /** content width of one page (the column width), px */
  pageW: number
  /** column gap between pages, px */
  gap: number
}

export const pageStep = (g: PageGeom): number => g.pageW + g.gap

export const clampPage = (p: number, count: number): number =>
  Math.max(0, Math.min(p, Math.max(0, count - 1)))

/**
 * Layout-static x (px from strip start) → page index.
 * Rounding absorbs sub-pixel drift against the k·step column anchors.
 */
export function pageForX(x: number, g: PageGeom): number {
  const step = pageStep(g)
  if (step <= 0) return 0
  return Math.max(0, Math.round(x / step))
}

/**
 * Strip width → page count. Content genuinely inside column k forces
 * stripWidth past k·step, so plain ceil agrees with pageForX's rounding.
 */
export function pageCountFor(stripWidth: number, g: PageGeom): number {
  const step = pageStep(g)
  if (step <= 0 || stripWidth <= 0) return 1
  return Math.max(1, Math.ceil(stripWidth / step))
}

export interface SectionPageBound {
  sec: number
  page: number
}

/** Section start-page boundaries (ascending) → section owning a page. */
export function sectionForPage(
  bounds: SectionPageBound[],
  page: number,
): number {
  if (!bounds.length) return 0
  let owner = bounds[0].sec
  for (const b of bounds) {
    if (b.page <= page) owner = b.sec
    else break
  }
  return owner
}
