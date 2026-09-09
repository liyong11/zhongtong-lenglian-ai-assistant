function parseSseEvent(block) {
  const lines = block.split(/\r?\n/)
  const event = (lines.find(line => line.startsWith('event:')) || 'event: message').slice(6).trim()
  const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
  if (!raw || raw === '[DONE]') return { event, done: true }
  try { return { event, data: JSON.parse(raw) } }
  catch { return null }
}

export async function consumeSseStream(body, onEvent) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    let separator
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const parsed = parseSseEvent(buffer.slice(0, separator.index))
      buffer = buffer.slice(separator.index + separator[0].length)
      if (parsed && !parsed.done) await onEvent(parsed)
    }
    if (done) break
  }

  const parsed = parseSseEvent(buffer)
  if (parsed && !parsed.done) await onEvent(parsed)
}
