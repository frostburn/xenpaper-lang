import type { Expression } from '../parser.js'

/** A score-only item requires the enclosing composition to play as a unit. */
export function needsScorePlayback(node: Expression): boolean {
  switch (node.type) {
    case 'Group':
    case 'PostfixExpression':
      return needsScorePlayback(node.expression)
    case 'NormalizeToSlot':
      return node.expression !== null && needsScorePlayback(node.expression)
    case 'Sequence':
      return node.items.some(needsScorePlayback)
    case 'Parallel':
      return node.branches.some(needsScorePlayback)
    case 'BinaryExpression':
      return node.operator === '->'
    case 'Rest':
    case 'BarRest':
    case 'Barline':
    case 'HardBoundary':
    case 'DetachedContinue':
    case 'DrumSampleLiteral':
    case 'Directive':
    case 'PitchContextChange':
    case 'MosDeclaration':
    case 'Repeat':
    case 'IfBlock':
    case 'ForBlock':
    case 'WhileBlock':
    case 'VariableDeclaration':
    case 'BindingAssignment':
    case 'FunctionDeclaration':
    case 'ThrowStatement':
    case 'LoopJump':
      return true
    default:
      return false
  }
}
