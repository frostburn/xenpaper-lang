import type { Expression, Identifier, Node } from '../parser.js'
import { catchableDiagnostic, EvaluationError, type Diagnostic } from '../diagnostics.js'
import { Value } from '../value.js'
import {
  evaluateDeclaration,
  evaluateExpression,
  evaluateThrow,
  isTruthy,
  stringValue,
} from './expressions.js'
import {
  extendLexicalEnvironment,
  type EvaluatedLiteral,
  type LexicalEnvironment,
  type PitchContext,
  type PrimeMapping,
} from './types.js'

export type FunctionBindings = WeakMap<LexicalEnvironment, Map<string, EvaluatedLiteral>>
export type ReturnEvaluator<R> = (
  expression: Expression,
  scope: LexicalEnvironment,
  protectedReturn: boolean,
) => R
type Frame = { scope: LexicalEnvironment }
type Transfer<R> =
  | { kind: 'return'; result: R }
  | { kind: 'jump'; jump: Extract<Expression, { type: 'LoopJump' }> }

export function executeFunctionStatements<R extends { diagnostics: readonly Diagnostic[] }>(
  statements: readonly Expression[],
  mapping: PrimeMapping | PitchContext,
  environment: LexicalEnvironment,
  bindings: FunctionBindings,
  budget: { remaining: number },
  evaluateReturn: ReturnEvaluator<R>,
): { environment?: LexicalEnvironment; returned?: R; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  // Record writes to this call's locals so an enclosing handler can undo them,
  // including writes made by a nested try that completed successfully.
  let journal:
    | { names: Map<string, EvaluatedLiteral>; name: string; previous: EvaluatedLiteral }[]
    | undefined
  function fail(node: Node, code: string, message: string): never {
    throw new EvaluationError([{ code, message, severity: 'error', locations: [node.location] }])
  }
  function spend(node: Node) {
    if (--budget.remaining < 0)
      fail(node, 'XP_EXPANSION_LIMIT', 'Function execution exceeded the statement expansion limit.')
  }
  function read(node: Expression, frame: Frame): EvaluatedLiteral {
    const result = evaluateExpression(node, mapping, frame.scope)
    if (!('value' in result)) throw new EvaluationError(result.diagnostics)
    diagnostics.push(...result.diagnostics)
    return result.value
  }
  function bind(scope: LexicalEnvironment, id: Identifier, value: EvaluatedLiteral): Frame {
    const variables = new Map([[id.name, value]])
    const child = extendLexicalEnvironment(scope, { variables })
    bindings.set(child, variables)
    return { scope: child }
  }
  function block(nodes: readonly Expression[], frame: Frame): Transfer<R> | undefined {
    for (const node of nodes) {
      const completion = execute(node, frame)
      if (completion) return completion
    }
  }
  function execute(node: Expression, frame: Frame): Transfer<R> | undefined {
    spend(node)
    switch (node.type) {
      case 'Sequence':
        return block(node.items, frame)
      case 'FunctionDeclaration':
      case 'VariableDeclaration': {
        const declared = evaluateDeclaration(node, mapping, frame.scope)
        if (declared.diagnostics.some((d) => d.severity === 'error'))
          throw new EvaluationError(declared.diagnostics)
        diagnostics.push(...declared.diagnostics)
        frame.scope = declared.environment
        if (node.type === 'VariableDeclaration') {
          const variables = new Map(frame.scope.variables)
          frame.scope = { ...frame.scope, variables }
          bindings.set(frame.scope, variables)
        }
        return
      }
      case 'BindingAssignment': {
        const name = node.name.name
        for (let scope: LexicalEnvironment | undefined = frame.scope; scope; scope = scope.parent) {
          if (scope.functions.has(name)) break
          if (!scope.variables.has(name)) continue
          const names = bindings.get(scope)
          if (!names) break
          const value = read(node.value, frame)
          journal?.push({ names, name, previous: names.get(name)! })
          names.set(name, value)
          return
        }
        return fail(
          node.name,
          'XP_ASSIGNMENT',
          `Assignment requires a local variable or parameter named ${name}.`,
        )
      }
      case 'ReturnStatement': {
        const result = evaluateReturn(node.value, frame.scope, journal !== undefined)
        if (journal && result.diagnostics.some((d) => d.severity === 'error'))
          throw new EvaluationError(result.diagnostics)
        return { kind: 'return', result }
      }
      case 'LoopJump':
        return { kind: 'jump', jump: node }
      case 'ThrowStatement':
        throw new EvaluationError(evaluateThrow(node, mapping, frame.scope))
      case 'IfBlock': {
        const branch = isTruthy(read(node.condition, frame)) ? node.consequent : node.alternate
        if (branch) return execute(branch, { ...frame })
        return
      }
      case 'TryBlock': {
        const enclosing = journal
        const writes = journal ?? []
        const checkpoint = writes.length
        const warnings = diagnostics.length
        journal = writes
        try {
          return block(node.body.items, { ...frame })
        } catch (error) {
          if (!(error instanceof EvaluationError)) throw error
          const failure = catchableDiagnostic(error.diagnostics)
          if (!failure) throw error
          for (let i = writes.length - 1; i >= checkpoint; --i) {
            const { names, name, previous } = writes[i]!
            names.set(name, previous)
          }
          writes.length = checkpoint
          diagnostics.length = warnings
          journal = enclosing
          const handler = node.name
            ? bind(
                frame.scope,
                node.name,
                stringValue(failure.message, [
                  { role: 'structural', location: node.name.location },
                ]),
              )
            : { ...frame }
          return block(node.handler.items, handler)
        } finally {
          journal = enclosing
        }
      }
      case 'WhileBlock':
      case 'ForBlock': {
        const local = { ...frame }
        const iterable = node.type === 'ForBlock' ? read(node.iterable, frame) : undefined
        if (node.type === 'ForBlock' && iterable?.kind !== 'container')
          return fail(node.iterable, 'XP_NOT_ITERABLE', `for ${node.mode} requires a container.`)
        for (let i = 0; ; i++) {
          let iteration = local
          if (node.type === 'WhileBlock') {
            spend(node)
            if (!isTruthy(read(node.condition, local))) break
          } else {
            if (iterable?.kind !== 'container' || i >= iterable.values.length) break
            spend(node)
            const item =
              node.mode === 'of'
                ? iterable.values[i]!
                : {
                    kind: 'scalar' as const,
                    value: new Value(i),
                    origins: [{ role: 'structural' as const, location: node.name.location }],
                  }
            iteration = bind(frame.scope, node.name, item)
          }
          const completion = block(node.body.items, iteration)
          if (completion?.kind === 'return') return completion
          if (completion?.jump.action === 'break') return
        }
        if (node.alternate) return block(node.alternate.items, { ...frame })
        return
      }
      default:
        return fail(
          node,
          'XP_FUNCTION_STATEMENT',
          `${node.type} cannot be executed before ret in a function.`,
        )
    }
  }
  const frame = { scope: environment }
  try {
    // The top-level trailing ret is the call's result operand. Earlier returns
    // and loop condition checks count as executed statements.
    const tail = statements.at(-1)
    const hasOperand = tail?.type === 'ReturnStatement'
    const completion = block(hasOperand ? statements.slice(0, -1) : statements, frame)
    if (completion?.kind === 'jump')
      fail(
        completion.jump,
        'XP_LOOP_JUMP',
        `${completion.jump.action} requires an enclosing loop body in the same function.`,
      )
    const returned =
      completion?.result ??
      (hasOperand ? evaluateReturn(tail.value, frame.scope, false) : undefined)
    return { environment: frame.scope, returned, diagnostics }
  } catch (error) {
    if (!(error instanceof EvaluationError)) throw error
    return { diagnostics: [...diagnostics, ...error.diagnostics] }
  }
}
