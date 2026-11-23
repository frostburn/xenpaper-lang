import { copyFile } from 'node:fs/promises'

for (const filename of ['parser.generated.js', 'parser.generated.d.ts']) {
  await copyFile(
    new URL('../src/' + filename, import.meta.url),
    new URL('../dist/' + filename, import.meta.url),
  )
}
