import type { ContainerValue, EvaluatedLiteral } from './types.js'

let pending: unknown[][] | undefined

function write(args: unknown[]): void {
  if (pending) pending.push(args)
  else console.log(...args)
}

function quote(text: string): string {
  return `«${JSON.stringify(text).slice(1, -1).replaceAll('»', '\\»')}»`
}

function formatMember(item: EvaluatedLiteral): string {
  if (item.kind === 'string') return quote(item.text)
  if (item.kind === 'undefined') return 'niente'
  if (item.kind === 'record') {
    const fields = [...item.fields].map(([key, value]) => `${quote(key)}: ${formatMember(value)}`)
    return `record { ${fields.join(', ')} }`
  }
  if (item.kind === 'scalar' && !item.boolean) {
    const exact = item.value.exactRational()
    if (exact) return exact.toFraction()
  }
  if (item.kind === 'pitchOffset') {
    if (item.scaleDegree !== undefined && !item.degreeModifiers?.length)
      return `${item.scaleDegree}d`
    return item.spelling?.raw ?? `${item.value.valueOf()}c`
  }
  return String(printable(item))
}

function formatContainer(item: ContainerValue): string {
  const members = item.values.map(formatMember)
  const parallel = item.composition === 'parallel'
  const contents =
    parallel && members.length === 1 ? `${members[0]},` : members.join(parallel ? ', ' : ' ')
  // Empty and singleton parallels use their own parentheses even inside a slot.
  const parentheses = `(${contents})`
  const postfix = item.postfixMarks?.map((mark) => mark.raw).join('') ?? ''
  let body = parentheses
  if (item.normalized) {
    body = `[${parallel && members.length < 2 ? parentheses : contents}]`
  } else if (postfix && !item.composition && members.length === 1) {
    body = contents
  }
  const marked = body + postfix
  return item.grouped && (item.normalized || postfix) ? `(${marked})` : marked
}

function printable(item: EvaluatedLiteral): unknown {
  switch (item.kind) {
    case 'string':
      return item.text
    case 'undefined':
      return undefined
    case 'scalar':
      if (item.boolean) return !item.value.isZero()
      return item.value.dimensions.isDimensionless ? item.value.valueOf() : item.value.toString()
    case 'absolutePitch':
      return item.spelling.raw
    case 'pitchOffset':
      return item.spelling?.raw ?? item.value.toString()
    case 'container':
      return formatContainer(item)
    case 'record':
      return Object.fromEntries([...item.fields].map(([key, value]) => [key, printable(value)]))
    case 'scoreFragment':
      return '<score>'
    case 'lambda':
      return '<lambda>'
    case 'function':
      return `<function ${item.definition.declaration.name.name}>`
  }
}

export function print(args: readonly EvaluatedLiteral[]): void {
  const formatted = args.map(printable)
  // A collection can contain literal percent signs that console.log would interpolate.
  if (args[0]?.kind === 'container' && formatted.length > 1 && String(formatted[0]).includes('%'))
    formatted.unshift('%s')
  write(formatted)
}

/** Speculative score passes can discard their logs along with their results. */
export function capturePrints<T>(evaluate: () => T) {
  const enclosing = pending
  const messages: unknown[][] = []
  pending = messages
  try {
    return { result: evaluate(), flush: () => messages.forEach(write) }
  } finally {
    pending = enclosing
  }
}
