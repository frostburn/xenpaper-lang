import type { Expression } from '../parser.js'

// These forms need a score cursor or an executing lexical scope. Container syntax
// around any of them captures the whole phrase so its children play together.
const scoreForms = new Set<Expression['type']>([
  'Barline',
  'BarRest',
  'BindingAssignment',
  'DetachedContinue',
  'Directive',
  'DrumSampleLiteral',
  'ForBlock',
  'FunctionDeclaration',
  'HardBoundary',
  'IfBlock',
  'LoopJump',
  'MosDeclaration',
  'PitchContextChange',
  'Repeat',
  'RepeatChain',
  'Rest',
  'ThrowStatement',
  'TryBlock',
  'VariableDeclaration',
  'WhileBlock',
])

export function needsScorePlayback(node: Expression): boolean {
  switch (node.type) {
    case 'Group':
    case 'PostfixExpression':
      return needsScorePlayback(node.expression)
    case 'NormalizeToSlot':
      return !!node.expression && needsScorePlayback(node.expression)
    case 'Parallel':
      return node.branches.some(needsScorePlayback)
    case 'Sequence':
      return node.items.some(needsScorePlayback)
    case 'BinaryExpression':
      return node.operator === '->'
    default:
      return scoreForms.has(node.type)
  }
}
