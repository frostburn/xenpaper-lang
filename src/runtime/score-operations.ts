import { Fraction } from 'xen-dev-utils/fraction'
import type { Diagnostic } from '../diagnostics.js'
import type { Expression, Repeat } from '../parser.js'
import { resolveDirective } from './directives.js'
import { evaluateExpression, isComparison } from './expressions.js'
import { expandHarmonicSegment } from './harmonic-segments.js'
import { needsScorePlayback } from './score-fragments.js'
import type { ExpansionPath, LexicalEnvironment, PitchContext } from './types.js'

export type ScoreExpression = Expression & {
  readonly expansionPath?: ExpansionPath
  readonly broadcastArticulation?: Fraction
}
type BroadcastScalar = {
  expression: Expression
  articulation: Fraction
  continuations: Extract<Expression, { type: 'PostfixExpression' }>['marks']
}

export function expandEnumeratedChord(
  node: Expression,
  context: PitchContext,
  environment?: LexicalEnvironment,
): { expressions: Expression[]; diagnostics: Diagnostic[] } {
  const expand = (child: Expression) => expandEnumeratedChord(child, context, environment)
  if (node.type === 'EnumeratedChord')
    return expandHarmonicSegment(node, (member) => evaluateExpression(member, context, environment))
  if (
    node.type === 'Group' ||
    node.type === 'UnaryExpression' ||
    node.type === 'PitchModifierExpression'
  ) {
    const inner = node.type === 'Group' ? node.expression : node.operand
    const { expressions, diagnostics } = expand(inner)
    return {
      expressions: expressions.map((item) =>
        item === inner
          ? node
          : node.type === 'Group'
            ? { ...node, expression: item }
            : { ...node, operand: item },
      ),
      diagnostics,
    }
  }
  if (node.type === 'BinaryExpression' && !isComparison(node.operator)) {
    const left = expand(node.left)
    const right = expand(node.right)
    return {
      // Each enumerand on one side sounds together with every enumerand on the other side.
      expressions: left.expressions.flatMap((a) =>
        right.expressions.map((b) =>
          a === node.left && b === node.right ? node : { ...node, left: a, right: b },
        ),
      ),
      diagnostics: [...left.diagnostics, ...right.diagnostics],
    }
  }
  return { expressions: [node], diagnostics: [] }
}

const structuralItems = new Set<Expression['type']>([
  'Barline',
  'BarRest',
  'Directive',
  'Rest',
  'DetachedContinue',
  'HardBoundary',
  'PitchContextChange',
])

/** Unwrap a single pitch expression together with the performance context authored around it. */
function broadcastScalar(
  node: ScoreExpression,
  context: PitchContext,
  environment?: LexicalEnvironment,
): BroadcastScalar | undefined {
  switch (node.type) {
    case 'BinaryExpression':
      if (node.operator === '->') return
      break
    case 'Group':
      return broadcastScalar(node.expression, context, environment)
    case 'PostfixExpression': {
      const scalar = broadcastScalar(node.expression, context, environment)
      if (scalar)
        return {
          ...scalar,
          continuations: [
            ...scalar.continuations,
            ...node.marks.filter((mark) => mark.type === 'DetachedContinue'),
          ],
        }
      return
    }
    case 'Sequence': {
      let scalar: BroadcastScalar | undefined
      let articulation: Fraction | undefined
      for (const item of node.items) {
        if (item.type === 'Directive') {
          const { directive } = resolveDirective(item, context, environment)
          if (directive?.kind !== 'articulation') return
          articulation = directive.ratio
        } else {
          if (scalar) return
          scalar = broadcastScalar(item, context, environment)
          if (!scalar) return
        }
      }
      return scalar && { ...scalar, articulation: articulation ?? scalar.articulation }
    }
    case 'NormalizeToSlot':
      if (node.expression) return
      break
    case 'Parallel':
    case 'EnumeratedChord':
    case 'Repeat':
    case 'RepeatChain':
      return
  }
  if (!structuralItems.has(node.type))
    return {
      expression: node,
      articulation: node.broadcastArticulation ?? new Fraction(1),
      continuations: [],
    }
}

type ScoreOperation = Extract<
  Expression,
  { type: 'BinaryExpression' | 'UnaryExpression' | 'PitchModifierExpression' }
>

function isScoreOperation(node: Expression): node is ScoreOperation {
  if (node.type === 'UnaryExpression') return true
  if (node.type === 'PitchModifierExpression') return true
  return node.type === 'BinaryExpression' && !isComparison(node.operator) && node.operator !== '->'
}

function isConstruction(node: Expression): boolean {
  switch (node.type) {
    case 'BinaryExpression':
      return node.operator === '->'
    case 'Group':
      return isConstruction(node.expression)
    case 'NormalizeToSlot':
      return node.expression !== null
    case 'Sequence':
    case 'Parallel':
    case 'PostfixExpression':
    case 'Repeat':
    case 'RepeatChain':
      return true
    default:
      return false
  }
}

/** Visit pitch-producing leaves in their original rhythmic and lexical positions. */
function mapScoreMembers(
  node: ScoreExpression,
  operation: (member: ScoreExpression) => ScoreExpression,
): ScoreExpression {
  const visit = (item: ScoreExpression) => mapScoreMembers(item, operation)
  function apply(item: ScoreExpression) {
    const updated = operation(item)
    return item.expansionPath ? { ...updated, expansionPath: item.expansionPath } : updated
  }
  const visitRepeat = (repeat: Repeat): Repeat => ({
    ...repeat,
    body: repeat.body.map(visit),
    endings: repeat.endings.map((ending) => ({ ...ending, body: ending.body.map(visit) })),
    ...(repeat.replayPrefix && { replayPrefix: repeat.replayPrefix.map(visit) }),
  })
  switch (node.type) {
    case 'Sequence':
      return { ...node, items: node.items.map(visit) }
    case 'Parallel':
      return { ...node, branches: node.branches.map(visit) }
    case 'Group':
      return { ...node, expression: visit(node.expression) }
    case 'PostfixExpression':
      return { ...node, expression: apply(node.expression) }
    case 'NormalizeToSlot':
      if (!node.expression) break
      return { ...node, expression: visit(node.expression) }
    case 'Repeat':
      return visitRepeat(node)
    case 'RepeatChain':
      return { ...node, repeats: node.repeats.map(visitRepeat) }
    case 'BinaryExpression':
      if (node.operator === '->')
        return { ...node, left: visit(node.left), right: visit(node.right) }
      break
  }
  if (structuralItems.has(node.type)) return node
  return apply(node)
}

function isScalarLeaf(node: Expression): boolean {
  if (node.type === 'Group') return isScalarLeaf(node.expression)
  return node.type !== 'EnumeratedChord' && !isConstruction(node) && !needsScorePlayback(node)
}

function zipScoreMembers(
  left: ScoreExpression,
  right: ScoreExpression,
  operator: Extract<Expression, { type: 'BinaryExpression' }>,
): ScoreExpression | undefined {
  const zip = (a: Expression, b: Expression) => zipScoreMembers(a, b, operator)
  function pairs(a: readonly Expression[], b: readonly Expression[]) {
    if (a.length !== b.length) return
    const zipped = a.map((item, index) => zip(item, b[index]!))
    return zipped.every((item) => item !== undefined) ? zipped : undefined
  }
  if (left.type === 'Group' && right.type === 'Group') {
    const expression = zip(left.expression, right.expression)
    return expression && { ...left, expression }
  }
  if (left.type === 'NormalizeToSlot' && right.type === 'NormalizeToSlot') {
    if (!left.expression && !right.expression) return { ...operator, left, right }
    if (!left.expression || !right.expression) return
    const expression = zip(left.expression, right.expression)
    return expression && { ...left, expression }
  }
  if (left.type === 'Sequence' && right.type === 'Sequence') {
    const items = pairs(left.items, right.items)
    return items && { ...left, items }
  }
  if (left.type === 'Parallel' && right.type === 'Parallel') {
    const branches = pairs(left.branches, right.branches)
    return branches && { ...left, branches }
  }
  if (!isScalarLeaf(left) || !isScalarLeaf(right)) return
  return {
    ...operator,
    left,
    right,
    ...(left.expansionPath && { expansionPath: left.expansionPath }),
  }
}

export function broadcastScalarOperation(
  node: ScoreExpression,
  context: PitchContext,
  environment?: LexicalEnvironment,
): ScoreExpression | undefined {
  if (!isScoreOperation(node)) return
  // Expose a construction produced by nested arithmetic before matching the outer operands.
  function operand(item: Expression): ScoreExpression {
    if (item.type === 'Group') {
      const inner = operand(item.expression)
      return inner === item.expression ? item : { ...item, expression: inner }
    }
    return broadcastScalarOperation(item, context, environment) ?? item
  }
  if (node.type !== 'BinaryExpression') {
    const inner = operand(node.operand)
    if (!isConstruction(inner)) return
    return mapScoreMembers(inner, (operand) => ({ ...node, operand }))
  }
  const left = operand(node.left)
  const right = operand(node.right)
  // Matching syntax retains its engraving and scope. Other pairs of collection
  // values use ordinary container arithmetic in the expression evaluator.
  if (left.type === right.type && (left.type === 'Group' || isConstruction(left))) {
    const zipped = zipScoreMembers(left, right, node)
    if (zipped) return zipped
  }
  const lhs = isConstruction(right) && broadcastScalar(left, context, environment)
  const scalar = lhs || (isConstruction(left) && broadcastScalar(right, context, environment))
  if (!scalar)
    return left === node.left && right === node.right ? undefined : { ...node, left, right }
  const construction = lhs ? right : left
  const mapped = mapScoreMembers(construction, (member) => ({
    ...node,
    left: lhs ? scalar.expression : member,
    right: lhs ? member : scalar.expression,
    broadcastArticulation:
      member.broadcastArticulation && member.broadcastArticulation.compare(scalar.articulation) > 0
        ? member.broadcastArticulation
        : scalar.articulation,
  }))
  if (!scalar.continuations.length) return mapped
  if (mapped.type === 'PostfixExpression') {
    const existing = mapped.marks.filter((mark) => mark.type === 'DetachedContinue').length
    return { ...mapped, marks: [...mapped.marks, ...scalar.continuations.slice(existing)] }
  }
  return {
    type: 'PostfixExpression',
    expression: mapped,
    marks: scalar.continuations,
    location: construction.location,
  }
}
