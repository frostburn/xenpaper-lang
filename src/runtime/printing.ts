let pending: unknown[][] | undefined

export function print(args: unknown[]): void {
  if (pending) pending.push(args)
  else console.log(...args)
}

/** Speculative score passes can discard their logs along with their results. */
export function capturePrints<T>(evaluate: () => T) {
  const enclosing = pending
  const messages: unknown[][] = []
  pending = messages
  try {
    return { result: evaluate(), flush: () => messages.forEach(print) }
  } finally {
    pending = enclosing
  }
}
