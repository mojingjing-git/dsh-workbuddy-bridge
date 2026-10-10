/**
 * End-to-end check of the adapter against a LIVE gateway.
 *
 * This is the check that unit tests structurally cannot be: it opens a real SSE
 * stream from the real gateway and runs it through the real adapter and DSH's
 * real `BlockAssembler`. The `usage: null` crash survived 85 unit tests because
 * every fixture omitted the field entirely — a test that invents its own fixture
 * cannot find a bug in the difference between that fixture and the real wire.
 *
 * Usage:
 *   node scripts/manual/e2e.mjs text  [model]
 *   node scripts/manual/e2e.mjs tools [model ...]
 *
 * Requires a built `lib/`: run `pnpm run build` first.
 * Exit codes: 0 pass, 1 adapter threw, 2 no tool call, 3 tool arguments did not
 * parse as JSON.
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

import { WorkbuddyLlmAdapter, WORKBUDDY_PROVIDER } from '../../lib/host/llm-adapter.js'
import { WorkbuddyClient } from '../../lib/host/workbuddy-client.js'
import { resolveGateway, describeGateway } from './gateway.mjs'

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}

function makeAdapter(gateway) {
  const client = new WorkbuddyClient({
    baseURL: gateway.baseURL,
    apiKey: gateway.apiKey,
  })
  return new WorkbuddyLlmAdapter(client)
}

/** Run one call and return the assembler plus whether it threw. */
async function runOnce(adapter, model, { tools } = {}) {
  const assembler = new BlockAssembler()
  const types = new Set()
  let error = null
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
              text:
                tools === undefined
                  ? 'Reply with exactly: PONG'
                  : 'What is the weather in Beijing right now?',
            },
          ],
          source: { kind: 'user' },
        }),
      ],
      ...(tools === undefined ? {} : { tools }),
    })) {
      types.add(chunk.type)
      assembler.push(chunk)
    }
  } catch (e) {
    error = e
  }
  return { assembler, types: [...types], error, elapsed: Date.now() - started }
}

function reportText(model, result) {
  console.log(`\n--- text turn: ${model} ---`)
  console.log(`elapsed : ${result.elapsed} ms`)
  console.log(`chunks  : ${result.types.join(', ')}`)
  if (result.error) {
    console.log(`THREW   : ${result.error.name} | ${result.error.message} | code=${result.error.code}`)
    return false
  }
  const blocks = result.assembler.blocks()
  console.log(`blocks  : ${blocks.map((b) => b.type).join(', ')}`)
  console.log(`finish  : ${JSON.stringify(result.assembler.finish)}`)
  console.log(`usage   : ${JSON.stringify(result.assembler.usage)}`)
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  console.log(`text    : ${text.slice(0, 120)}`)
  return text.length > 0
}

function reportTools(model, result) {
  console.log(`\n--- tool-call turn: ${model} ---`)
  console.log(`elapsed : ${result.elapsed} ms`)
  if (result.error) {
    console.log(`THREW   : ${result.error.name} | ${result.error.message} | code=${result.error.code}`)
    return 1
  }
  const blocks = result.assembler.blocks()
  console.log(`blocks  : ${blocks.map((b) => b.type).join(', ')}`)
  console.log(`finish  : ${JSON.stringify(result.assembler.finish)}`)

  const call = blocks.find((b) => b.type === 'tool-call')
  if (call === undefined) {
    console.log('TOOL CALL: none — this model answered in prose instead')
    const text = blocks.find((b) => b.type === 'text')
    if (text) console.log(`  text  : ${text.text.slice(0, 160)}`)
    return 2
  }
  console.log(`TOOL CALL: ${call.name}`)
  console.log(`  id     : ${call.id}`)
  console.log(`  args   : ${call.arguments}  (typeof ${typeof call.arguments})`)
  try {
    console.log(`  parsed : ${JSON.stringify(JSON.parse(call.arguments))}`)
  } catch (e) {
    console.log(`  parsed : FAILED — ${e.message}`)
    return 3
  }
  return 0
}

const mode = process.argv[2] ?? 'text'
const models = process.argv.slice(3)
const gateway = resolveGateway()
describeGateway(gateway)

let worst = 0
if (mode === 'text') {
  const model = models[0] ?? 'hy3-x'
  const ok = reportText(model, await runOnce(makeAdapter(gateway), model))
  worst = ok ? 0 : 1
} else if (mode === 'tools') {
  const list = models.length > 0 ? models : ['hy3-x', 'glm-5.3', 'glm-5.2']
  for (const model of list) {
    const result = await runOnce(makeAdapter(gateway), model, { tools: [WEATHER_TOOL] })
    const code = reportTools(model, result)
    worst = Math.max(worst, code)
  }
} else {
  console.error(`unknown mode "${mode}"; expected "text" or "tools"`)
  process.exit(64)
}

console.log(`\nexit ${worst}`)
process.exit(worst)
