// Toggle semantics for the highlight color menu: picking the color a
// passage already wears removes it; picking another replaces it. Pure —
// the pane supplies the marks overlapping the selection.

export interface ExistingMark {
  id: string
  color: string
}

export interface MarkAction {
  /** overlapping marks to remove first (never stack two on one passage) */
  removeIds: string[]
  /** the new color, or null when the choice toggled the mark off */
  addColor: string | null
}

export function planMarkAction(
  existing: ExistingMark[],
  chosen: string,
): MarkAction {
  const removeIds = existing.map((e) => e.id)
  const addColor = existing.some((e) => e.color === chosen) ? null : chosen
  return { removeIds, addColor }
}
