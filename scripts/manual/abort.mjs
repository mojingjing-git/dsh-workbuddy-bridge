/**
 * Abort handling, against the live gateway.
 *
 * The one path the other manual checks do not reach: DSH stops a generation by
 * aborting the request signal, and the result the user sees is the runtime's
 * normalization of that, not the adapter's raw behaviour.
 *
 * The adapter is expected to **throw** on abort. `LlmRuntime` catches a throw
 * from mid-iteration and runs it through:
 *
 *     function adapterFailureChunk(error, signal) {
 *       const failure = normalizeLlmFailure(error)
 *       return { type: 'finish', reason: signal?.aborted || failure.code === 'ABORTED'
 *         ? { kind: 'aborted', failure } : { kind: 'error', failure } }
 *     }
 *
 * and it sets `completed = true` first, so the iterator's `return()` is not
 * called and the chunks already yielded survive. A check that only looks at the
 * adapter would report a bare throw and miss that; this applies the same
 * normalization so the output is what a user actually gets.
 *
 * Usage: node scripts/manual/abort.mjs [model]
 * Exit codes: 0 aborted cleanly, 1 it finished normally, 2 an unexpected error.
 *
 * Requires a built `lib/`: run `pnpm run build` first.
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

import { WorkbuddyLlmAdapter, WORKBUDDY_PROVIDER } from '../../lib/host/llm-adapter.js'
import { WorkbuddyClient } from '../../lib/host/workbuddy-client.js'
import { resolveGateway, describeGateway } from './gateway.mjs'

const gateway = resolveGateway()
describeGateway(gateway)

const model = process.argv[2] ?? 'glm-5.2'
const client = new WorkbuddyClient({ baseURL: gateway.baseURL, apiKey: gateway.apiKey })
const adapter = new WorkbuddyLlmAdapter(client)

const controller = new AbortController()
const assembler = new BlockAssembler()
let error = null
let chunksBeforeAbort = 0
let abortedAt = 0
/**
 * Whether a `finish` chunk actually arrived.
 *
 * `BlockAssembler.finish` is **not** undefined when nothing finished — it reads
 * back a default `{kind: 'stop'}` — so testing it for undefined reports a clean
 * completion for a stream that was aborted mid-flight. That is exactly the
 * wrong answer here, so the chunk itself is tracked.
 */
let sawFinishChunk = false

const started = Date.now()
try {
  for await (const chunk of adapter.stream({
    provider: WORKBUDDY_PROVIDER,
    model,
    messages: [
      createUserMessage({
        content: [
          {
            type: 'text',
            // Long enough that the abort lands mid-stream rather than after the
            // model has already stopped.
            text: 'Count from 1 to 200, one number per line, with no commentary.',
          },
        ],
        source: { kind: 'user' },
      }),
    ],
    signal: controller.signal,
  })) {
    chunksBeforeAbort += 1
    if (chunk.type === 'finish') sawFinishChunk = true
    assembler.push(chunk)
    // Abort as soon as content is flowing.
    if (chunksBeforeAbort === 5 && abortedAt === 0) {
      abortedAt = Date.now() - started
      controller.abort(new Error('user stopped the generation'))
    }
  }
} catch (e) {
  error = e
}

const elapsed = Date.now() - started
console.log(`\nmodel         : ${model}`)
console.log(`aborted after : ${abortedAt} ms (${chunksBeforeAbort} chunks)`)
console.log(`total         : ${elapsed} ms`)

if (error !== null) {
  console.log(`adapter threw : ${error.name} | ${error.message} | code=${error.code}`)
}

// The runtime's normalization, so the outcome below is what DSH acts on rather
// than what the adapter happened to do. `LlmRuntime` converts a mid-iteration
// throw into a terminal chunk whenever the signal is aborted, which is the
// whole reason the adapter is allowed to throw here at all.
let finish = sawFinishChunk ? assembler.finish : undefined
console.log(`finish chunk  : ${sawFinishChunk ? 'received' : 'none (the stream did not complete)'}`)
if (finish === undefined) {
  const failure =
    error !== null
      ? (error.failure ?? { message: error.message, code: error.code ?? 'UNKNOWN' })
      : { message: 'stream ended with no finish and no error', code: 'UNKNOWN' }
  finish =
    controller.signal.aborted || failure.code === 'ABORTED'
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure }
}
console.log(`normalized    : ${JSON.stringify(finish)}`)

const text = assembler
  .blocks()
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('')

if (finish?.kind === 'aborted') {
  console.log(`blocks kept   : ${assembler.blocks().map((b) => b.type).join(', ') || '(none)'}`)
  console.log(`partial text  : ${text.slice(0, 60)}${text.length > 60 ? '…' : ''} (${text.length} chars)`)
  // Keeping the partial output is the property that matters: a user who stops a
  // generation must not lose what was already on screen.
  const kept = text.length > 0 || assembler.blocks().length > 0
  console.log(kept ? '\nOK — aborted, and the partial content survived.' : '\nABORTED BUT EMPTY — partial content was lost.')
  process.exit(kept ? 0 : 2)
}

console.log(`\nNOT ABORTED — the stream finished as "${finish?.kind}" instead.`)
process.exit(1)
