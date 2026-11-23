import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const consumer = mkdtempSync(join(tmpdir(), 'xenpaper-lang-consumer-'))

function runNpm(args, cwd) {
  const cli = process.env.npm_execpath
  execFileSync(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args, {
    cwd,
    stdio: 'inherit',
  })
}

try {
  runNpm(['pack', '--pack-destination', consumer, '--silent'], root)
  const tarball = readdirSync(consumer).find((name) => name.endsWith('.tgz'))
  if (!tarball) throw new Error('npm pack did not produce a tarball')
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', './' + tarball], consumer)

  writeFileSync(
    join(consumer, 'consumer.mts'),
    `import { expandToBeatEvents, parse, type Program, type XenpaperParserOptions } from 'xenpaper-lang'

const options: XenpaperParserOptions = { grammarSource: 'smoke-test' }
const program: Program = parse('[C D E] F=', options)
if (program.location.source !== options.grammarSource) throw new Error('Missing source location')
const result = expandToBeatEvents(program)
if (result.diagnostics.length || !('score' in result)) throw new Error('Could not evaluate score')
const starts = result.score.events.filter(event => event.kind === 'note').map(note => note.start.toFraction())
if (starts.join(',') !== '0,1/3,2/3,1' || !result.score.duration.equals(3)) {
  throw new Error('Unexpected note timing: ' + starts.join(','))
}
`,
  )
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, types: [] },
      files: ['consumer.mts'],
    }),
  )
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(process.execPath, [tsc, '-p', '.'], { cwd: consumer, stdio: 'inherit' })
  execFileSync(process.execPath, ['consumer.mjs'], { cwd: consumer, stdio: 'inherit' })
} finally {
  rmSync(consumer, { recursive: true, force: true })
}
