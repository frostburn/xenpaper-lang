/** Number of written equaves added by this modifier. Other modifiers alter the pitch within an equave. */
export function equaveShift(kind: string): number {
  switch (kind) {
    case 'equaveUp':
      return 1
    case 'doubleEquaveUp':
      return 2
    case 'equaveDown':
      return -1
    default:
      return 0
  }
}

export function equaveShifts(modifiers: readonly { readonly kind: string }[]): number {
  return modifiers.reduce((total, modifier) => total + equaveShift(modifier.kind), 0)
}
