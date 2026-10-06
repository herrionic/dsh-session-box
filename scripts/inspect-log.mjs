/**
 * Print the reminder events of one session log, as the host reads them back.
 *
 * The projection folds events from the log, so a custom field that survives the
 * live append but not the round trip through persistence produces a state that
 * is correct in memory and empty after a restart.
 *
 *   node scripts/inspect-log.mjs <session-dir>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** Every line of one log, across all of its frames. */
function lines(buffer) {
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (MAGIC.every((byte, offset) => buffer[index + offset] === byte)) starts.push(index)
  }
  let text = ''
  starts.forEach((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch {
      // A frame that does not decompress contributes nothing.
    }
  })
  return text.split('\n').filter((line) => line !== '')
}

const dir = process.argv[2]
if (dir === undefined) throw new Error('usage: node scripts/inspect-log.mjs <session-dir>')

const rows = lines(readFileSync(join(dir, 'session.v4.jsonl.zstd')))
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })
  .filter((row) => row !== undefined)

console.log(`rows: ${String(rows.length)}`)
for (const row of rows) {
  const source = row?.data?.source
  if (row.type !== 'user/message' || source === undefined) continue
  console.log(`seq=${String(row.seq)} kind=${String(source.kind)} keys=${Object.keys(source).join(',')}`)
  if (source.kind === 'sessionbox-target') {
    console.log(`   target=${JSON.stringify(source.target)} form=${String(source.form)}`)
  }
}
