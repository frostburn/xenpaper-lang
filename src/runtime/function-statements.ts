import type { Expression } from '../parser.js'
import type { Diagnostic } from '../diagnostics.js'
import { catchableDiagnostic } from '../diagnostics.js'
import { Value } from '../value.js'
import {
  evaluateDeclaration,
  evaluateExpression,
  evaluateThrow,
  isTruthy,
  stringValue,
} from './expressions.js'
import { extendLexicalEnvironment } from './types.js'
import type { EvaluatedLiteral, LexicalEnvironment, PitchContext, PrimeMapping } from './types.js'

export type FunctionBindings = WeakMap<LexicalEnvironment, Map<string, EvaluatedLiteral>>

type Jump = 'break' | 'continue'
type Completion<Result> = { scope: LexicalEnvironment; jump?: Jump; returned?: Result }

export type ReturnEvaluator<Result> = (
  expression: Expression,
  scope: LexicalEnvironment,
  protectedReturn: boolean,
) => Result

/** Execute function statements, including return operands reached inside a handler's trial. */
export function executeFunctionStatements<Result extends { diagnostics: readonly Diagnostic[] }>(
  statements: readonly Expression[],
  mapping: PrimeMapping | PitchContext,
  environment: LexicalEnvironment,
  bindings: FunctionBindings,
  budget: { remaining: number },
  evaluateReturn: ReturnEvaluator<Result>,
): { environment?: LexicalEnvironment; returned?: Result; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const abort = Symbol('function statement error')
  const fail = (node: Expression, code: string, message: string): never => {
    diagnostics.push({ code, severity: 'error', message, locations: [node.location] })
    throw abort
  }
  const spend = (node: Expression) => {
    if (--budget.remaining < 0)
      fail(node, 'XP_EXPANSION_LIMIT', 'Function execution exceeded the statement expansion limit.')
  }
  const evaluate = (node: Expression, scope: LexicalEnvironment): EvaluatedLiteral => {
    const evaluated = evaluateExpression(node, mapping, scope)
    diagnostics.push(...evaluated.diagnostics)
    if (!('value' in evaluated)) throw abort
    return evaluated.value
  }

  const run = (
    items: readonly Expression[],
    scope: LexicalEnvironment,
    inLoop: boolean,
    protectedReturn: boolean,
  ): Completion<Result> => {
    for (const statement of items) {
      spend(statement)
      switch (statement.type) {
        case 'Sequence': {
          const nested = run(statement.items, scope, inLoop, protectedReturn)
          if (nested.jump || nested.returned) return nested
          scope = nested.scope
          break
        }
        case 'VariableDeclaration':
        case 'FunctionDeclaration': {
          const declared = evaluateDeclaration(statement, mapping, scope)
          diagnostics.push(...declared.diagnostics)
          if (declared.diagnostics.some(({ severity }) => severity === 'error')) throw abort
          scope = declared.environment
          if (statement.type === 'VariableDeclaration') {
            const variables = new Map(scope.variables)
            scope = { ...scope, variables }
            bindings.set(scope, variables)
          }
          break
        }
        case 'BindingAssignment': {
          const { name } = statement.name
          let target: LexicalEnvironment | undefined = scope
          while (target && !target.variables.has(name) && !target.functions.has(name))
            target = target.parent
          const variables = target && bindings.get(target)
          if (!variables?.has(name))
            return fail(
              statement.name,
              'XP_ASSIGNMENT',
              `Assignment requires a local variable or parameter named ${name}.`,
            )
          variables.set(name, evaluate(statement.value, scope))
          break
        }
        case 'ThrowStatement':
          diagnostics.push(...evaluateThrow(statement, mapping, scope))
          throw abort
        case 'ReturnStatement': {
          const returned = evaluateReturn(statement.value, scope, protectedReturn)
          if (
            protectedReturn &&
            returned.diagnostics.some(({ severity }) => severity === 'error')
          ) {
            diagnostics.push(...returned.diagnostics)
            throw abort
          }
          return { scope, returned }
        }
        case 'LoopJump':
          if (!inLoop)
            fail(
              statement,
              'XP_LOOP_JUMP',
              `${statement.action} requires an enclosing loop body in the same function.`,
            )
          return { scope, jump: statement.action }
        case 'IfBlock': {
          const branch = isTruthy(evaluate(statement.condition, scope))
            ? statement.consequent
            : statement.alternate
          if (branch) {
            const branchResult = run([branch], scope, inLoop, protectedReturn)
            if (branchResult.returned) return branchResult
            if (branchResult.jump) return { scope, jump: branchResult.jump }
          }
          break
        }
        case 'TryBlock': {
          const start = diagnostics.length
          const snapshots = new Map<Map<string, EvaluatedLiteral>, Map<string, EvaluatedLiteral>>()
          for (let frame: LexicalEnvironment | undefined = scope; frame; frame = frame.parent) {
            const variables = bindings.get(frame)
            if (variables) snapshots.set(variables, new Map(variables))
          }
          try {
            const trial = run(statement.body.items, scope, inLoop, true)
            if (trial.returned) return trial
            if (trial.jump) return { scope, jump: trial.jump }
          } catch (error) {
            if (error !== abort) throw error
            const failure = catchableDiagnostic(diagnostics.slice(start))
            if (!failure) throw error
            diagnostics.length = start
            for (const [variables, saved] of snapshots)
              for (const [name, value] of saved) variables.set(name, value)
            const name = statement.name
            let handlerScope = scope
            if (name) {
              const variables = new Map<string, EvaluatedLiteral>([
                [
                  name.name,
                  stringValue(failure.message, [{ location: name.location, role: 'structural' }]),
                ],
              ])
              handlerScope = extendLexicalEnvironment(scope, { variables })
              bindings.set(handlerScope, variables)
            }
            const handler = run(statement.handler.items, handlerScope, inLoop, protectedReturn)
            if (handler.returned) return handler
            if (handler.jump) return { scope, jump: handler.jump }
          }
          break
        }
        case 'ForBlock':
        case 'WhileBlock': {
          let broke = false
          if (statement.type === 'ForBlock') {
            const iterable = evaluate(statement.iterable, scope)
            if (iterable.kind !== 'container')
              return fail(
                statement.iterable,
                'XP_NOT_ITERABLE',
                `for ${statement.mode} requires a container.`,
              )
            for (const [index, item] of iterable.values.entries()) {
              spend(statement)
              const value: EvaluatedLiteral =
                statement.mode === 'in'
                  ? { kind: 'scalar', value: new Value(index), origins: [] }
                  : item
              const variables = new Map([[statement.name.name, value]])
              const inner = extendLexicalEnvironment(scope, { variables })
              bindings.set(inner, variables)
              const iteration = run(statement.body.items, inner, true, protectedReturn)
              if (iteration.returned) return iteration
              if (iteration.jump === 'break') {
                broke = true
                break
              }
            }
          } else {
            let inner = scope
            for (;;) {
              spend(statement)
              if (!isTruthy(evaluate(statement.condition, inner))) break
              const iteration = run(statement.body.items, inner, true, protectedReturn)
              if (iteration.returned) return iteration
              inner = iteration.scope
              if (iteration.jump === 'break') {
                broke = true
                break
              }
            }
          }
          if (!broke && statement.alternate) {
            const alternate = run(statement.alternate.items, scope, inLoop, protectedReturn)
            if (alternate.returned) return alternate
            if (alternate.jump) return { scope, jump: alternate.jump }
          }
          break
        }
        default:
          fail(
            statement,
            'XP_FUNCTION_STATEMENT',
            `${statement.type} cannot be executed before ret in a function.`,
          )
      }
    }
    return { scope }
  }

  try {
    const completed = run(statements, environment, false, false)
    return { environment: completed.scope, returned: completed.returned, diagnostics }
  } catch (error) {
    if (error !== abort) throw error
    return { diagnostics }
  }
}
