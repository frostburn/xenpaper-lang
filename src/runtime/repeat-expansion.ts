import type { LocationRange } from 'peggy'
import type { Expression, Node, Program, Repeat, RepeatChain, Sequence } from '../parser.js'
import { EvaluationError, type Diagnostic } from '../diagnostics.js'
import {
  deferredRepeatNodes,
  type ExpandedNode,
  type ExpansionPath,
  type RepeatExpansionOptions,
  type RepeatExpansionResult,
} from './types.js'

export function* resolveRepeatChain(repeats: readonly Repeat[]): Generator<Repeat> {
  const played: Repeat[] = []
  for (const section of repeats) {
    const reached = played.length ? { ...section, replayPrefix: played.slice() } : section
    yield reached
    played.push(reached)
  }
}

export function repeatBoundaryLocation(repeat: Repeat, edge: 'start' | 'end'): LocationRange {
  const { source, start, end } = repeat.location
  if (edge === 'end') {
    const width = repeat.terminal?.length ?? 0
    return {
      source,
      start: { ...end, column: end.column - width, offset: end.offset - width },
      end,
    }
  }
  if (repeat.startMarkerLocation) return repeat.startMarkerLocation
  const implicit =
    repeat.startMarkerLocation === null || repeat.body?.[0]?.location.start.offset === start.offset
  return {
    source,
    start,
    end: implicit ? start : { ...start, column: start.column + 2, offset: start.offset + 2 },
  }
}

const deferred = new Set<string>(deferredRepeatNodes)
const isSyntax = (value: unknown): value is Node =>
  !!value && typeof value === 'object' && 'type' in value && 'location' in value

export function expandRepeats(
  program: Program,
  options: RepeatExpansionOptions = {},
  onEmission?: () => void,
  deferRepeats = false,
): RepeatExpansionResult {
  return expandRepeatsFrom([], program, options, onEmission, deferRepeats)
}

export function expandRepeatsFrom(
  initialPath: ExpansionPath,
  program: Program,
  options: RepeatExpansionOptions,
  onEmission?: () => void,
  deferRepeats = false,
): RepeatExpansionResult {
  const diagnostics: Diagnostic[] = []
  const limit = options.expansionLimit ?? 100_000
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError('expansionLimit must be a non-negative safe integer.')
  let nodesLeft = limit
  let passesLeft = limit
  // Restrict recovery to errors from this expansion. The caller can enforce its own budget.
  class ExpansionFailure extends EvaluationError {}
  function exhausted(node: Node, unit: 'node' | 'iteration'): never {
    throw new ExpansionFailure([
      {
        severity: 'error',
        code: 'XP_REPEAT_EXPANSION_LIMIT',
        locations: [node.location],
        message: `Repeat expansion exceeded the ${limit}-${unit} limit.`,
      },
    ])
  }
  function emitted(node: Node) {
    onEmission?.()
    if (--nodesLeft < 0) exhausted(node, 'node')
  }
  function group(node: Node, path: ExpansionPath): Node {
    const children = [...expand(node, path)]
    if (children.length === 1) return children[0]!
    const sequence = {
      type: 'Sequence',
      items: children,
      location: node.location,
      expansionPath: path,
    }
    emitted(sequence)
    return sequence
  }
  // List positions splice occurrences. In a single operand or parallel branch the
  // same stream occupies one position, so group() wraps zero or multiple children.
  function* items(nodes: readonly Expression[], path: ExpansionPath): Generator<ExpandedNode> {
    for (const node of nodes) {
      for (const expanded of expand(node, path)) {
        const expression = expanded as ExpandedNode
        if (expression.type === 'Sequence') yield* expression.items
        else yield expression
      }
    }
  }
  function* expand(node: Node, path: ExpansionPath): Generator<Node> {
    if (!deferRepeats && node.type === 'RepeatChain') {
      for (const section of resolveRepeatChain((node as RepeatChain).repeats))
        yield* unfold(section, path)
      return
    }
    if (!deferRepeats && node.type === 'Repeat') {
      yield* unfold(node as Repeat, path)
      return
    }
    emitted(node)
    const copy: Node & Record<string, unknown> = { ...node, expansionPath: path }
    if (!deferred.has(node.type) && node.type !== 'Repeat' && node.type !== 'RepeatChain') {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'location' || key.endsWith('Location') || key === 'expansionPath') continue
        if (node.type === 'Sequence' && key === 'items')
          copy.items = [...items((node as Sequence).items, path)]
        else if (isSyntax(child)) copy[key] = group(child, path)
        else if (Array.isArray(child))
          copy[key] = child.map((item) => (isSyntax(item) ? group(item, path) : item))
      }
    }
    yield copy
  }
  function* unfold(section: Repeat, parent: ExpansionPath): Generator<ExpandedNode> {
    const { count, location } = section
    const endings = section.endings ?? []
    const body = section.body ?? []
    const replayPrefix = section.replayPrefix ?? []
    if (section.incompleteEndings)
      diagnostics.push({
        severity: 'warning',
        code: 'XP_INCOMPLETE_REPEAT_ENDINGS',
        message: 'Alternate endings ended without a subsequent numbered ending.',
        locations: [location],
      })
    let times: bigint
    try {
      times = count ? BigInt(String(count.value)) : 2n
    } catch {
      times = -1n
    }
    if (times < 0n) {
      diagnostics.push({
        severity: 'error',
        code: 'XP_REPEAT_COUNT',
        message: 'Repeat count must be an exact non-negative integer.',
        locations: [count?.location ?? location],
      })
      return
    }
    const selected = new Map<bigint, number>()
    for (const [index, ending] of endings.entries()) {
      const pass = BigInt(ending.number.value) - 1n
      if (!selected.has(pass)) selected.set(pass, index)
    }
    for (let pass = 0n; pass < times; pass++) {
      if (--passesLeft < 0) exhausted(section, 'iteration')
      const path = [
        ...parent,
        {
          ...(location.source !== undefined && { source: location.source }),
          repeatOffset: location.start.offset,
          iteration: Number(pass),
        },
      ]
      const bar = (at: LocationRange): ExpandedNode => ({
        type: 'Barline',
        raw: '|',
        location: at,
        expansionPath: path,
      })
      const opening = options.preserveBarlines && bar(repeatBoundaryLocation(section, 'start'))
      if (opening) yield opening
      let commonItems = false
      if (pass > 0n)
        for (const item of items(replayPrefix, path)) {
          commonItems = true
          yield item
        }
      for (const item of items(body, path)) {
        commonItems = true
        yield item
      }
      const index = selected.get(pass)
      let endingBar: ExpandedNode | undefined
      if (index !== undefined) {
        const ending = endings[index]!
        if (opening) {
          endingBar = bar(ending.markerLocation)
          yield endingBar
        }
        yield* items(ending.body, path)
      }
      if (opening) {
        // Charge authored children before their synthesized grid markers so a
        // limit diagnostic points at the same source regardless of stream order.
        if (endingBar) emitted(endingBar)
        emitted(opening)
        const next = index === undefined ? undefined : endings[index + 1]
        const at =
          next?.markerLocation ?? (section.terminal && repeatBoundaryLocation(section, 'end'))
        if (at) {
          const closing = bar(at)
          emitted(closing)
          yield closing
        }
      }
      if (!commonItems && !endings.length && (pass > 0n || !replayPrefix.length)) break
    }
  }
  try {
    return {
      program: {
        ...program,
        expansionPath: initialPath,
        body: [...items(program.body, initialPath)],
      },
      diagnostics,
    }
  } catch (error) {
    if (!(error instanceof ExpansionFailure)) throw error
    return { diagnostics: [...diagnostics, ...error.diagnostics] }
  }
}
