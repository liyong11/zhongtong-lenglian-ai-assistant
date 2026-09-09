import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeSseStream } from './streamResponse.mjs'

function streamOf(...chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)))
      controller.close()
    },
  })
}

test('consumes SSE events across CRLF boundaries and partial chunks', async () => {
  const events = []
  await consumeSseStream(streamOf(
    'event: ready\r\n',
    'data: {"mode":"app"}\r',
    '\n\r\n',
    'event: chunk\n',
    'data: {"text":"你"}\n\n',
    'event: chunk\n',
    'data: {"text":"好"}\n',
    '\n',
    'data: [DONE]\n\n',
  ), event => events.push(event))

  assert.deepEqual(events, [
    { event: 'ready', data: { mode: 'app' } },
    { event: 'chunk', data: { text: '你' } },
    { event: 'chunk', data: { text: '好' } },
  ])
})
