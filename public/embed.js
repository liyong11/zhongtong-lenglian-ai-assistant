(() => {
  if (document.querySelector('iframe[data-zto-ai-widget]')) return
  const script = document.currentScript
  if (!script) return
  const serviceOrigin = new URL(script.src).origin
  const side = script.dataset.position === 'left' ? 'left' : 'right'
  const sideGap = script.dataset.side || '24'
  const bottomGap = script.dataset.bottom || '24'
  const frame = document.createElement('iframe')
  const url = new URL('/widget', serviceOrigin)
  // 仅嵌入方显式指定 data-title 时才覆盖名称，否则用管理后台「机器人形象」配置
  if (script.dataset.title) url.searchParams.set('title', script.dataset.title)
  frame.src = url.toString()
  frame.title = script.dataset.title || 'AI 智能助理'
  frame.dataset.ztoAiWidget = 'true'
  frame.setAttribute('allow', 'clipboard-write')
  Object.assign(frame.style, {
    position: 'fixed',
    [side]: `${Number(sideGap) || 24}px`,
    bottom: `${Number(bottomGap) || 24}px`,
    width: '80px',
    height: '80px',
    border: '0',
    background: 'transparent',
    zIndex: script.dataset.zIndex || '2147483000',
  })
  document.body.appendChild(frame)

  window.addEventListener('message', event => {
    if (event.origin !== serviceOrigin || event.source !== frame.contentWindow) return
    const message = event.data
    if (!message || message.source !== 'zto-ai-widget' || message.type !== 'resize') return
    frame.style.top = 'auto'
    frame.style.left = side === 'left' ? `${Number(sideGap) || 24}px` : 'auto'
    frame.style.right = side === 'right' ? `${Number(sideGap) || 24}px` : 'auto'
    frame.style.bottom = `${Number(bottomGap) || 24}px`
    if (message.state === 'collapsed') {
      frame.style.width = '80px'
      frame.style.height = '80px'
    } else if (message.state === 'maximized') {
      Object.assign(frame.style, { top: '0', left: '0', right: '0', bottom: '0', width: '100vw', height: '100vh' })
    } else {
      frame.style.width = 'min(760px, calc(100vw - 32px))'
      frame.style.height = 'min(660px, calc(100vh - 32px))'
    }
  })
})()
