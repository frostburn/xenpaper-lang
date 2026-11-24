import { kCombinations } from 'xen-dev-utils'
import type { CoercionAnnotation, Expression } from '../parser.js'
import { Value } from '../value.js'
import type { ExpressionEvaluationResult } from './expressions.js'
import { evaluateLiteral } from './literals.js'
import { needsScorePlayback } from './score-fragments.js'
import {
  callableArity,
  isCallableValue,
  type CallableValue,
  type ContainerValue,
  type EvaluatedLiteral,
  type LexicalEnvironment,
  type SourceOrigin,
} from './types.js'

export type ExpressionEvaluator = (
  node: Expression,
  environment?: LexicalEnvironment,
) => ExpressionEvaluationResult
type CallbackEvaluator = (
  callable: CallableValue,
  args: readonly EvaluatedLiteral[],
) => ExpressionEvaluationResult
type Coercion = CoercionAnnotation | 'container' | 'integer' | 'pitch' | 'ratio' | null | undefined

export function requireInteger(item: EvaluatedLiteral, name: string): number {
  const exact = item.kind === 'scalar' && item.value.exactRational()
  if (!exact || exact.d !== 1) throw new TypeError(`${name} must be an integer.`)
  return exact.s * exact.n
}

function container(
  values: readonly EvaluatedLiteral[],
  origins: readonly SourceOrigin[] = [],
): ContainerValue {
  return { kind: 'container', values, origins, value: new Value(0) }
}

export function evaluateBuiltinArgument(
  node: Expression,
  coercion: Coercion,
  environment: LexicalEnvironment,
  evaluate: ExpressionEvaluator,
): ExpressionEvaluationResult {
  if (needsScorePlayback(node)) return evaluate(node, environment)
  const name = typeof coercion === 'string' ? coercion : coercion?.name
  if (
    node.type === 'DegreeLiteral' &&
    !node.explicit &&
    (name === 'integer' || name === 'ratio' || name === 'boolean')
  ) {
    return evaluateLiteral({
      type: 'IntegerLiteral',
      raw: node.raw,
      value: node.degree,
      location: node.location,
    })
  }
  if (node.type === 'Group') {
    const item = evaluateBuiltinArgument(node.expression, coercion, environment, evaluate)
    return 'value' in item && item.value.kind === 'container'
      ? { ...item, value: { ...item.value, grouped: true } }
      : item
  }
  if (node.type === 'PostfixExpression') {
    const item = evaluateBuiltinArgument(node.expression, coercion, environment, evaluate)
    if (!('value' in item)) return item
    return {
      ...item,
      value: {
        ...container([item.value], [{ role: 'literal', location: node.location }]),
        postfixMarks: node.marks,
      },
    }
  }
  if (node.type !== 'Parallel' && node.type !== 'Sequence' && node.type !== 'NormalizeToSlot')
    return evaluate(node, environment)
  const contents = node.type === 'NormalizeToSlot' ? node.expression : node
  const members =
    contents?.type === 'Parallel'
      ? contents.branches
      : contents?.type === 'Sequence'
        ? contents.items
        : contents
          ? [contents]
          : []
  const element = typeof coercion === 'object' && coercion?.element ? coercion.element : coercion
  const children = members.map((member) =>
    evaluateBuiltinArgument(member, element, environment, evaluate),
  )
  const diagnostics = children.flatMap((child) => child.diagnostics)
  if (!children.every((child) => 'value' in child)) return { diagnostics }
  const compound = contents?.type === 'Parallel' || contents?.type === 'Sequence'
  const location = compound ? contents.location : node.location
  return {
    value: {
      ...container(
        children.map((child) => child.value),
        contents ? [{ role: 'literal', location }] : [],
      ),
      ...(compound && { composition: contents.type === 'Parallel' ? 'parallel' : 'sequence' }),
      ...(node.type === 'NormalizeToSlot' && { normalized: true }),
    },
    diagnostics,
  }
}

const signatures = {
  pitch: ['ratio'],
  ratio: ['pitch'],
  flat: ['container'],
  sorted: ['container'],
  sort: ['container'],
  asSequence: ['container'],
  asParallel: ['container'],
  kCombinations: ['container', 'integer'],
  arrayMap: [null, 'container'],
  arrayReduce: [null, 'container', null],
} as const

function convert(item: EvaluatedLiteral, target: 'pitch' | 'ratio'): EvaluatedLiteral {
  if (item.kind === 'container')
    return { ...item, values: item.values.map((v) => convert(v, target)) }
  if (item.kind !== 'pitchOffset' && item.kind !== 'scalar')
    throw new TypeError(
      target === 'pitch' ? 'pitch() expects scalar ratios.' : 'ratio() expects pitch offsets.',
    )
  const { origins } = item
  if (target === 'ratio')
    return item.kind === 'scalar'
      ? item
      : { kind: 'scalar', value: Value.ratio(item.value), origins }
  const value = item.kind === 'scalar' ? Value.pitch(item.value) : item.value
  return { kind: 'pitchOffset', value, justIntonation: true, origins }
}

export function evaluateBuiltinCall(
  node: Extract<Expression, { type: 'CallExpression' }>,
  environment: LexicalEnvironment,
  evaluate: ExpressionEvaluator,
  invoke: CallbackEvaluator,
): ExpressionEvaluationResult {
  if (!Object.hasOwn(signatures, node.callee))
    return {
      diagnostics: [
        {
          code: 'XP_UNDEFINED_NAME',
          severity: 'error',
          message: `Undefined function ${node.callee}().`,
          locations: [node.location],
        },
      ],
    }
  const name = node.callee as keyof typeof signatures
  const parameters = signatures[name]
  const count = node.arguments.length
  const min = name === 'arrayReduce' ? 2 : parameters.length
  if (count < min || count > parameters.length) {
    const expected = min === parameters.length ? String(min) : `${min} to ${parameters.length}`
    throw new TypeError(
      `${name}() expects ${expected} argument${parameters.length === 1 ? '' : 's'}, but received ${count}.`,
    )
  }
  const supplied = node.arguments.map((argument, index) =>
    evaluateBuiltinArgument(argument, parameters[index], environment, evaluate),
  )
  const diagnostics = supplied.flatMap((argument) => argument.diagnostics)
  if (!supplied.every((argument) => 'value' in argument)) return { diagnostics }
  const args = supplied.map((argument) => argument.value)
  if (name === 'pitch' || name === 'ratio') return { value: convert(args[0]!, name), diagnostics }
  const higherOrder = name === 'arrayMap' || name === 'arrayReduce'
  function collection(index: number) {
    const input = args[index]!
    if (input.kind !== 'container') throw new TypeError(`${name}() expects a container.`)
    return input
  }
  if (higherOrder) {
    const callback = args[0]!
    const arity = name === 'arrayMap' ? 1 : 2
    const accepted = isCallableValue(callback) && callableArity(callback)
    if (!accepted || arity < accepted[0] || arity > accepted[1])
      throw new TypeError(
        `${name}() expects a function that accepts ${arity === 1 ? 'one argument' : 'two arguments'}.`,
      )
    const input = collection(1)
    const mapped: EvaluatedLiteral[] = []
    let accumulator = args[2]
    for (const member of input.values) {
      if (name === 'arrayReduce' && accumulator === undefined) {
        accumulator = member
        continue
      }
      const result = invoke(callback, name === 'arrayMap' ? [member] : [accumulator!, member])
      diagnostics.push(...result.diagnostics)
      if (!('value' in result)) return { diagnostics }
      if (name === 'arrayMap') mapped.push(result.value)
      else accumulator = result.value
    }
    if (name === 'arrayMap')
      return {
        value: { ...input, values: mapped, origins: [...callback.origins, ...input.origins] },
        diagnostics,
      }
    if (accumulator) return { value: accumulator, diagnostics }
    throw new TypeError('arrayReduce() cannot reduce an empty container without an initial value.')
  }
  const input = collection(0)
  const { values } = input
  let value: EvaluatedLiteral
  switch (name) {
    case 'asParallel':
    case 'asSequence':
      value = {
        ...container(values, input.origins),
        composition: name === 'asParallel' ? 'parallel' : 'sequence',
      }
      break
    case 'flat':
      value = {
        ...input,
        values: values.flatMap((item) => (item.kind === 'container' ? item.values : [item])),
      }
      break
    case 'sort':
    case 'sorted': {
      const numeric = values.map((item) => {
        if (item.kind !== 'pitchOffset' && item.kind !== 'scalar')
          throw new TypeError(`${name}() expects numeric values.`)
        return item
      })
      value = {
        ...input,
        values: numeric.sort((a, b) =>
          a.value.dimensions.equals(b.value.dimensions)
            ? a.value.compare(b.value)
            : a.value.valueOf() - b.value.valueOf(),
        ),
      }
      break
    }
    case 'kCombinations': {
      const k = requireInteger(args[1]!, 'Combination size')
      const origins = [...input.origins, ...args[1]!.origins]
      value = container(
        kCombinations([...values], k).map((items) => container(items, origins)),
        origins,
      )
      break
    }
  }
  return { value, diagnostics }
}
