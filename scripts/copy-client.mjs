// Copy the verbatim ESM `client.js` from `src/` to `lib/` so the
// `./client` export resolves. We do this with a Node script instead of
// tsc so the file is treated as plain text (not parsed as TS, which it
// is not).
import { mkdir, copyFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const src = 'src/client/client.js'
const dest = 'lib/client/client.js'
await mkdir(dirname(dest), { recursive: true })
await copyFile(src, dest)
console.log(`copied ${src} -> ${dest}`)
