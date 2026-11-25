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
  let index = 0
  const orphaned = new Set(layout.orphaned)
  function visit(node: ScoreShape): ScoreShape {
    switch (node.kind) {
      case 'sequence':
        return { ...node, children: node.children.map(visit) }
      case 'parallel':
        return { ...node, branches: node.branches.map(visit) }
      case 'continue':
        return orphaned.has(node) ? node : rest(node.duration, node.origins)
      case 'attack': {
        const note = layout.notes[index++]!
        if (removed?.has(note)) return rest(node.duration, node.origins)
        const attack = {
          ...node,
          duration: note.duration,
          origins: note.origins,
          automation: note.automation,
        }
        const delay = note.start.sub(note.slotStart)
        if (!delay.n && node.duration.equals(note.duration) && note.origins === node.origins)
          return attack
        const branch: ScoreShape = delay.n
          ? {
              kind: 'sequence',
              duration: delay.add(note.duration),
              origins: node.origins,
              children: [rest(delay, node.origins), attack],
            }
          : attack
        return {
          kind: 'parallel',
          duration: node.duration,
          origins: node.origins,
          branches: [branch],
        }
      }
      default:
        return node
    }
  }
  return visit(shape)
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
    continuationTarget: 'all',
    children: [materialize(left, sources), materialize(right, targets, removed)],
    duration: left.duration.add(right.duration),
    origins,
  }
}
