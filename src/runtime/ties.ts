import { Fraction } from 'xen-dev-utils/fraction'
import { EvaluationError } from '../diagnostics.js'
import type { ScoreShape, SourceOrigin } from './types.js'
import { layoutNotes, type PlacedNote } from './note-layout.js'

function rest(duration: Fraction, origins: readonly SourceOrigin[]): ScoreShape {
  return { kind: 'rest', generated: true, duration, origins }
}

/** Put edited notes back in their written slots so later onsets and scope changes stay in place. */
function materialize(
  shape: ScoreShape,
  layout: ReturnType<typeof layoutNotes>,
  removed?: Set<PlacedNote>,
): ScoreShape {
  let noteIndex = 0
  let placementIndex = 0
  const orphaned = new Set(layout.orphaned)
  function place(node: ScoreShape, slotDuration: Fraction, delay: Fraction): ScoreShape {
    if (!delay.n && node.duration.equals(slotDuration)) return node
    const branch: ScoreShape = delay.n
      ? {
          kind: 'sequence',
          duration: delay.add(node.duration),
          origins: node.origins,
          children: [rest(delay, node.origins), node],
        }
      : node
    return { kind: 'parallel', duration: slotDuration, origins: node.origins, branches: [branch] }
  }
  function visit(node: ScoreShape, allocated: Fraction): ScoreShape {
    const { start, end } = layout.placements[placementIndex++]!
    const duration = end.sub(start)
    // A continued normalized slot may stretch past its written allocation.
    // Its children use the stretched grid while the wrapper keeps the outer cursor.
    const scale = node.duration.n ? duration.div(node.duration) : new Fraction(1)
    switch (node.kind) {
      case 'sequence': {
        const children = node.children.map((child) => visit(child, child.duration.mul(scale)))
        return place({ ...node, duration, children }, allocated, new Fraction(0))
      }
      case 'parallel': {
        const branches = node.branches.map((branch) => visit(branch, branch.duration.mul(scale)))
        return place({ ...node, duration, branches }, allocated, new Fraction(0))
      }
      case 'continue':
        return orphaned.has(node) ? { ...node, duration } : rest(duration, node.origins)
      case 'attack': {
        const note = layout.notes[noteIndex++]!
        if (removed?.has(note)) return rest(allocated, node.origins)
        const attack = {
          ...node,
          duration: note.duration,
          origins: note.origins,
          automation: note.automation,
        }
        return place(attack, allocated, note.start.sub(start))
      }
      default:
        return duration.equals(node.duration) ? node : { ...node, duration }
    }
  }
  return visit(shape, shape.duration)
}

export function materializeScoreContinuations(shape: ScoreShape): ScoreShape {
  const layout = layoutNotes(shape)
  if (layout.diagnostics.length) throw new EvaluationError(layout.diagnostics)
  return materialize(shape, layout)
}

export function tieScoreShapes(
  left: ScoreShape,
  right: ScoreShape,
  origins: readonly SourceOrigin[],
): ScoreShape {
  const sources = layoutNotes(left)
  const targets = layoutNotes(right)
  const diagnostics = [...sources.diagnostics, ...targets.diagnostics]
  if (diagnostics.length) throw new EvaluationError(diagnostics)
  const removed = new Set<PlacedNote>()
  for (const source of sources.notes) {
    let end: Fraction | undefined
    const matched: SourceOrigin[] = []
    for (const target of targets.notes) {
      if (!source.pitch.value.equals(target.pitch.value)) continue
      removed.add(target)
      const release = left.duration.add(target.start).add(target.duration)
      if (!end || release.compare(end) > 0) end = release
      for (const origin of target.origins) matched.push(origin)
    }
    if (end) {
      source.duration = end.sub(source.start)
      source.origins = [...source.origins, ...origins, ...matched]
    }
  }
  return {
    kind: 'sequence',
    ...(removed.size && { continuationTarget: 'end' as const }),
    children: removed.size
      ? [materialize(left, sources), materialize(right, targets, removed)]
      : [left, right],
    duration: left.duration.add(right.duration),
    origins,
  }
}
