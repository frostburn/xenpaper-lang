import type { LocationRange } from 'peggy'
import type {
  Expression,
  Node,
  Program,
  Repeat,
  RepeatChain,
  Sequence,
} from '../parser.generated.js'
import type { Diagnostic } from '../diagnostics.js'
import { deferredRepeatNodes } from './types.js'
import type {
  ExpandedNode,
  ExpansionPath,
  RepeatExpansionOptions,
  RepeatExpansionResult,
} from './types.js'

const DEFAULT_EXPANSION_LIMIT = 100_000

type ExpandedSyntax = Node & { readonly expansionPath: ExpansionPath }
const deferredTypes = new Set<string>(deferredRepeatNodes)

class ExpansionLimitError extends Error {}

/** Resolve each reached repeat against the sections already played in this chain. */
export function* resolveRepeatChain(repeats: readonly Repeat[]): Generator<Repeat> {
  const prefix: Repeat[] = []
  for (const written of repeats) {
    const repeat = prefix.length ? { ...written, replayPrefix: [...prefix] } : written
    prefix.push(repeat)
    yield repeat
  }
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  )
}

/** Locate written repeat tokens and anchor implicit boundaries at a zero-width position. */
export function repeatBoundaryLocation(repeat: Repeat, edge: 'start' | 'end'): LocationRange {
  const { source, start, end } = repeat.location
  if (edge === 'end') {
    const width = repeat.terminal?.length ?? 0
    return {
      source,
      start: { ...end, offset: end.offset - width, column: end.column - width },
      end,
    }
  }
  if (repeat.startMarkerLocation) return repeat.startMarkerLocation
  // Older parser trees identify an implicit start by the first item's shared offset.
  if (
    repeat.startMarkerLocation === null ||
    repeat.body?.[0]?.location.start.offset === start.offset
  )
    return { source, start, end: start }
  return { source, start, end: { ...start, offset: start.offset + 2, column: start.column + 2 } }
}

/** Expand repeat macros while retaining a distinct provenance path on every occurrence. */
export function expandRepeats(
  program: Program,
  options: RepeatExpansionOptions = {},
  onEmission?: () => void,
  deferRepeats = false,
): RepeatExpansionResult {
  return expandRepeatsFrom([], program, options, onEmission, deferRepeats)
}

/** A deferred block starts its expansion inside the caller's active repeat iterations. */
export function expandRepeatsFrom(
  initialPath: ExpansionPath,
  program: Program,
  options: RepeatExpansionOptions,
  onEmission?: () => void,
  deferRepeats = false,
): RepeatExpansionResult {
  const diagnostics: Diagnostic[] = []
  const limit = options.expansionLimit ?? DEFAULT_EXPANSION_LIMIT
  let emitted = 0
  let iterations = 0

  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('expansionLimit must be a non-negative safe integer.')
  }

  const countEmission = (node: Node) => {
    onEmission?.()
    emitted += 1
    if (emitted > limit) {
      diagnostics.push({
        code: 'XP_REPEAT_EXPANSION_LIMIT',
        severity: 'error',
        message: `Repeat expansion exceeded the ${limit}-node limit.`,
        locations: [node.location],
      })
      throw new ExpansionLimitError()
    }
  }

  // Repeats splice expressions. Other syntax (such as a pitch nominal) keeps its node kind.
  function cloneNode(node: Expression, path: ExpansionPath): ExpandedNode[]
  function cloneNode(node: Node, path: ExpansionPath): ExpandedSyntax[]
  function cloneNode(node: Node, path: ExpansionPath): ExpandedSyntax[] {
    if (node.type === 'RepeatChain' && !deferRepeats) {
      const result: ExpandedNode[] = []
      for (const repeat of resolveRepeatChain((node as RepeatChain).repeats)) {
        for (const item of cloneNode(repeat, path)) result.push(item)
      }
      return result
    }
    if (node.type === 'Repeat' && !deferRepeats) {
      const repeat = node as Repeat
      if (repeat.incompleteEndings) {
        diagnostics.push({
          code: 'XP_INCOMPLETE_REPEAT_ENDINGS',
          severity: 'warning',
          message: 'Alternate endings ended without a subsequent numbered ending.',
          locations: [node.location],
        })
      }
      const countNode = repeat.count
      let count: bigint
      try {
        count = countNode ? BigInt(String(countNode.value)) : 2n
      } catch {
        diagnostics.push({
          code: 'XP_REPEAT_COUNT',
          severity: 'error',
          message: 'Repeat count must be an exact non-negative integer.',
          locations: [countNode?.location ?? node.location],
        })
        return []
      }
      if (count < 0n) {
        diagnostics.push({
          code: 'XP_REPEAT_COUNT',
          severity: 'error',
          message: 'Repeat count must be an exact non-negative integer.',
          locations: [countNode?.location ?? node.location],
        })
        return []
      }

      const result: ExpandedNode[] = []
      const endings = repeat.endings ?? []
      const endingsByIteration = new Map<bigint, Expression[]>()
      for (const ending of endings) {
        const iteration = BigInt(String(ending.number.value)) - 1n
        // Duplicate ending numbers select the first ending, matching Array.find's behavior.
        if (!endingsByIteration.has(iteration)) endingsByIteration.set(iteration, ending.body)
      }
      const body = repeat.body ?? []
      const replayPrefix = repeat.replayPrefix ?? []
      const appendChildren = (
        target: ExpandedNode[],
        source: readonly Expression[],
        iterationPath: ExpansionPath,
      ) => {
        for (const child of source) {
          for (const clone of cloneNode(child, iterationPath)) {
            // A repeat is an AST splice, not an evaluation boundary. The grammar
            // represents a run of score items as a Sequence, so retaining that
            // wrapper per iteration would incorrectly isolate stateful directives.
            if (clone.type === 'Sequence') {
              for (const item of clone.items) target.push(item)
            } else target.push(clone)
          }
        }
      }
      for (let iteration = 0n; iteration < count; iteration += 1n) {
        if (++iterations > limit) {
          diagnostics.push({
            code: 'XP_REPEAT_EXPANSION_LIMIT',
            severity: 'error',
            message: `Repeat expansion exceeded the ${limit}-iteration limit.`,
            locations: [node.location],
          })
          throw new ExpansionLimitError()
        }
        if (iteration > BigInt(Number.MAX_SAFE_INTEGER)) {
          // The normal node limit makes this unreachable with default options,
          // but paths deliberately use ordinary, interoperable numbers.
          diagnostics.push({
            code: 'XP_REPEAT_COUNT',
            severity: 'error',
            message: 'Repeat count is too large to identify every occurrence.',
            locations: [countNode?.location ?? node.location],
          })
          return result
        }
        const iterationPath = [
          ...path,
          {
            repeatOffset: node.location.start.offset,
            iteration: Number(iteration),
            ...(node.location.source !== undefined && { source: node.location.source }),
          },
        ]
        const children: ExpandedNode[] = []
        if (iteration > 0n) appendChildren(children, replayPrefix, iterationPath)
        appendChildren(children, body, iterationPath)
        const endingStart = children.length
        appendChildren(children, endingsByIteration.get(iteration) ?? [], iterationPath)
        const emptyEndingFree = !endings.length && !children.length && !replayPrefix.length
        // An empty, ending-free repeat has no playback occurrences. Preserve
        // mode emits its authored boundaries once for semantic validation,
        // then takes the same fast path rather than expanding every iteration.
        if (!options.preserveBarlines && emptyEndingFree) return result
        if (options.preserveBarlines) {
          const marker = (location: LocationRange): ExpandedNode => {
            const marker: ExpandedNode = {
              type: 'Barline',
              raw: '|',
              location,
              expansionPath: iterationPath,
            }
            countEmission(marker)
            return marker
          }
          const endingIndex = endings.findIndex(
            (ending) => BigInt(String(ending.number.value)) === iteration + 1n,
          )
          if (endingIndex >= 0) {
            const ending = endings[endingIndex]!
            children.splice(endingStart, 0, marker(ending.markerLocation))
          }
          children.unshift(marker(repeatBoundaryLocation(repeat, 'start')))
          const nextEnding = endings[endingIndex + 1]
          if (nextEnding && endingIndex >= 0) children.push(marker(nextEnding.markerLocation))
          else if (repeat.terminal) children.push(marker(repeatBoundaryLocation(repeat, 'end')))
        }
        result.push(...children)
        if (emptyEndingFree) return result
      }
      return result
    }

    countEmission(node)
    const clone: ExpandedSyntax & Record<string, unknown> = { ...node, expansionPath: path }
    // Blocks, bindings, and calls may contain scores that are played later.
    // Expand their repeats only when the evaluator visits the score.
    if (
      deferredTypes.has(node.type) ||
      ((node.type === 'Repeat' || node.type === 'RepeatChain') && deferRepeats)
    )
      return [clone]
    for (const [key, value] of Object.entries(node)) {
      if (key === 'location' || key === 'type' || key === 'expansionPath') continue
      if (Array.isArray(value)) {
        if (key === 'items' || key === 'body') {
          clone[key] = value
            .flatMap((item) => (isNode(item) ? cloneNode(item, path) : [item]))
            .flatMap((item) =>
              isNode(item) && item.type === 'Sequence' ? (item as Sequence).items : [item],
            )
        } else {
          clone[key] = value.map((item) => {
            if (!isNode(item)) return item
            const children = cloneNode(item, path)
            return children.length === 1 ? children[0] : makeSequence(children, item.location, path)
          })
        }
      } else if (isNode(value)) {
        const children = cloneNode(value, path)
        clone[key] =
          children.length === 1 ? children[0] : makeSequence(children, value.location, path)
      }
    }
    return [clone]
  }

  const makeSequence = (
    items: readonly ExpandedSyntax[],
    location: LocationRange,
    path: ExpansionPath,
  ) => {
    const node = { type: 'Sequence', items, location, expansionPath: path }
    countEmission(node)
    return node
  }

  try {
    const body = program.body
      .flatMap((node) => cloneNode(node, initialPath))
      .flatMap((node) => (node.type === 'Sequence' ? node.items : [node]))
    return {
      program: { ...program, body, expansionPath: initialPath },
      diagnostics,
    }
  } catch (error) {
    if (!(error instanceof ExpansionLimitError)) throw error
    return { diagnostics }
  }
}
