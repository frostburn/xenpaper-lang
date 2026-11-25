import type { Diagnostic } from '../diagnostics.js'
import type { Expression, Repeat } from '../parser.js'
import { resolveDirective } from './directives.js'
import { evaluateExpression, isComparison } from './expressions.js'
import { expandHarmonicSegment } from './harmonic-segments.js'
import { needsScorePlayback } from './score-fragments.js'
import type { ExpansionPath, LexicalEnvironment, PitchContext } from './types.js'

export type ScoreExpression = Expression & {
  readonly expansionPath?: ExpansionPath
}

export function expandEnumeratedChord(
  node: Expression,
  context: PitchContext,
  environment?: LexicalEnvironment,
): { expressions: Expression[]; diagnostics: Diagnostic[] } {
  const expand = (child: Expression) => expandEnumeratedChord(child, context, environment)
  if (node.type === 'EnumeratedChord')
    return expandHarmonicSegment(node, (member) => evaluateExpression(member, context, environment))
  if (node.type === 'Group' || (isScoreOperation(node) && node.type !== 'BinaryExpression')) {
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
  // An enumerated chord can transpose a rhythm-bearing score in parallel.
  // Arithmetic between values uses the elementwise rules instead.
  if (
    node.type === 'BinaryExpression' &&
    (node.operator === '+' || node.operator === '-') &&
    ((isConstruction(node.left) && !supportsValueArithmetic(node.left)) ||
      (isConstruction(node.right) && !supportsValueArithmetic(node.right)))
  ) {
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

/** Unwrap the pitch expression from a scalar with local articulation or timing marks. */
function broadcastScalar(
  node: ScoreExpression,
  context: PitchContext,
  environment?: LexicalEnvironment,
): Expression | undefined {
  switch (node.type) {
    case 'BinaryExpression':
      if (node.operator === '->') return
      break
    case 'Group':
      return broadcastScalar(node.expression, context, environment)
    case 'PostfixExpression':
      return broadcastScalar(node.expression, context, environment)
    case 'Sequence': {
      let scalar: Expression | undefined
      for (const item of node.items) {
        if (item.type === 'DetachedContinue' && scalar) continue
        if (item.type === 'Directive') {
          const { directive } = resolveDirective(item, context, environment)
          if (directive?.kind !== 'articulation') return
        } else {
          if (scalar) return
          scalar = broadcastScalar(item, context, environment)
          if (!scalar) return
        }
      }
      return scalar
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
  if (!structuralItems.has(node.type)) return node
}

type ScoreOperation = Extract<
  Expression,
  { type: 'BinaryExpression' | 'UnaryExpression' | 'PitchModifierExpression' }
>

function isScoreOperation(node: Expression): node is ScoreOperation {
  if (node.type === 'UnaryExpression') return node.operator !== '@not'
  if (node.type === 'PitchModifierExpression') return true
  return (
    node.type === 'BinaryExpression' &&
    node.operator !== 'al' &&
    node.operator !== '@and' &&
    node.operator !== '@or' &&
    node.operator !== '->' &&
    !isComparison(node.operator)
  )
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
    // An empty slot is a rest when the visitor reaches it in the score.
    if (item.type === 'NormalizeToSlot' && !item.expression) return item
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

function supportsValueArithmetic(node: Expression): boolean {
  switch (node.type) {
    case 'Group':
      return supportsValueArithmetic(node.expression)
    case 'NormalizeToSlot':
      return !!node.expression && supportsValueArithmetic(node.expression)
    case 'Sequence':
      return node.items.every(supportsValueArithmetic)
    case 'Parallel':
      return node.branches.every(supportsValueArithmetic)
    case 'PostfixExpression':
      return false
    default:
      return !needsScorePlayback(node)
  }
}

function canProduceContainer(node: Expression): boolean {
  switch (node.type) {
    case 'Identifier':
    case 'CallExpression':
    case 'IndexExpression':
    case 'ConditionalExpression':
    case 'EnumeratedChord':
      return true
    case 'Group':
      return canProduceContainer(node.expression)
    case 'UnaryExpression':
    case 'PitchModifierExpression':
      return isScoreOperation(node) && canProduceContainer(node.operand)
    case 'BinaryExpression':
      return (
        (node.operator === 'al' || isScoreOperation(node)) &&
        (canProduceContainer(node.left) || canProduceContainer(node.right))
      )
    default:
      return isConstruction(node)
  }
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
    if (!left.expression && !right.expression) return left
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
  const construction = lhs ? right : left
  // A reference or call can produce a container. Keep its shape intact for
  // elementwise arithmetic with constructions that can be evaluated as values.
  if (
    !scalar ||
    (!isConstruction(lhs ? left : right) &&
      canProduceContainer(scalar) &&
      supportsValueArithmetic(construction))
  )
    return left === node.left && right === node.right ? undefined : { ...node, left, right }
  return mapScoreMembers(construction, (member) => ({
    ...node,
    left: lhs ? scalar : member,
    right: lhs ? member : scalar,
  }))
}
