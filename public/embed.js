(() => {
  if (document.querySelector('iframe[data-zto-ai-widget]')) return
  const script = document.currentScript
  if (!script) return
  const serviceOrigin = new URL(script.src).origin
  const side = script.dataset.position === 'left' ? 'left' : 'right'
  const sideGap = Number(script.dataset.side) || 24
  const bottomGap = Number(script.dataset.bottom) || 24
  const FRAME = 80 // 待机（收起）时 iframe 尺寸，球 64 + 内边距 8
  const BALL = 64
  const INSET = 8
  const MARGIN = 8
  const POS_KEY = 'zto-ai-widget-pos'
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
    width: '80px',
    height: '80px',
    border: '0',
    background: 'transparent',
    zIndex: script.dataset.zIndex || '2147483000',
  })

  // ---------- 悬浮球位置：宿主域 localStorage 记忆（每个嵌入站点各自记住），null = 默认角落 ----------
  let ballPos = loadPos() // 球左上角 { left, bottom }
  if (!ballPos) {
    ballPos = side === 'left'
      ? { left: sideGap, bottom: bottomGap }
      : { left: Math.max(MARGIN, window.innerWidth - sideGap - BALL), bottom: bottomGap }
  }
  let state = 'collapsed' // collapsed(80×80 球) | drag(全屏拖动中) | open(聊天窗) | maximized(全屏聊天)
  applyCollapsed()
  document.body.appendChild(frame)

  function loadPos() {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.bottom)) return saved
    } catch { /* 隐私模式/无记忆：走默认角落 */ }
    return null
  }
  function clamp(v, min, max) { return Math.min(Math.max(v, min), Math.max(min, max)) }
  function clampFrame(left, bottom) {
    // 框可贴视口边缘（球在框内自带 8px 内边距，吸附后球距边缘正好 8px）
    return {
      left: clamp(left, 0, window.innerWidth - FRAME),
      bottom: clamp(bottom, 0, window.innerHeight - FRAME),
    }
  }
  function place(left, bottom, width, height) {
    frame.style.transition = 'none'
    frame.style.top = 'auto'
    frame.style.right = 'auto'
    frame.style.left = `${left}px`
    frame.style.bottom = `${bottom}px`
    frame.style.width = width
    frame.style.height = height
  }
  function applyCollapsed() {
    const p = clampFrame(ballPos.left - INSET, ballPos.bottom - INSET)
    place(p.left, p.bottom, '80px', '80px')
  }
  function expandFull() {
    frame.style.transition = 'none'
    Object.assign(frame.style, { top: '0', left: '0', right: '0', bottom: '0', width: '100vw', height: '100vh' })
  }
  function applyOpen() {
    // 聊天窗锚定球当前位置，保证完整可见
    const vw = window.innerWidth, vh = window.innerHeight
    const width = Math.min(760, vw - 32), height = Math.min(660, vh - 32)
    const left = clamp(ballPos.left - INSET, MARGIN, vw - width - MARGIN)
    const bottom = clamp(ballPos.bottom - INSET, MARGIN, vh - height - MARGIN)
    place(left, bottom, 'min(760px, calc(100vw - 32px))', 'min(660px, calc(100vh - 32px))')
  }

  // 视口变化后按当前状态重新钳位
  window.addEventListener('resize', () => {
    if (state === 'collapsed') applyCollapsed()
    else if (state === 'open') applyOpen()
    // drag/maximized 全屏，无需处理
  })

  window.addEventListener('message', event => {
    if (event.origin !== serviceOrigin || event.source !== frame.contentWindow) return
    const m = event.data
    if (!m || m.source !== 'zto-ai-widget') return

    // 用户点了隐藏：整个 iframe 移除显示（不持久化，刷新页面 embed.js 重新创建即恢复）
    if (m.type === 'hide') {
      frame.style.display = 'none'
      return
    }
    // 大动作（跳水/喷水）：临时扩框给动作空间，保持球屏幕位置不动，动作完缩回
    if (m.type === 'anim-expand') {
      const rect = frame.getBoundingClientRect()
      const ballLeft = rect.left + INSET, ballTop = rect.top + INSET
      const w = m.w, h = m.h
      const left = ballLeft - m.ax
      const bottom = window.innerHeight - (ballTop - m.ay) - h
      state = 'anim'
      place(left, bottom, `${w}px`, `${h}px`)
      frame.contentWindow.postMessage({ source: 'zto-ai-widget', type: 'anim-expanded', ax: m.ax, ay: m.ay, H: h }, serviceOrigin)
      return
    }
    if (m.type === 'anim-collapse') {
      state = 'collapsed'
      applyCollapsed()
      return
    }
    // 按下球：展开全屏透明层，让球在 iframe 内部原生拖动（无跨文档逐帧转发，零延迟零漂移）
    if (m.type === 'prepare') {
      // 展开前记录球当前位置（= iframe 当前位置 + 内边距），展开后球原位重锚
      const rect = frame.getBoundingClientRect()
      ballPos = { left: rect.left + INSET, bottom: window.innerHeight - rect.top - rect.height + INSET }
      state = 'drag'
      expandFull()
      frame.contentWindow.postMessage({ source: 'zto-ai-widget', type: 'expand', ballLeft: ballPos.left, ballTop: window.innerHeight - ballPos.bottom - BALL }, serviceOrigin)
      return
    }
    // 拖动结束：widget 上报吸附后的球位，存宿主并随后由 collapsed 收回小框
    if (m.type === 'launcher-pos') {
      ballPos = { left: Number(m.left), bottom: Number(m.bottom) }
      try { localStorage.setItem(POS_KEY, JSON.stringify(ballPos)) } catch { /* 隐私模式 */ }
      return
    }
    if (m.type !== 'resize') return
    if (m.state === 'collapsed') {
      state = 'collapsed'
      applyCollapsed()
    } else if (m.state === 'maximized') {
      state = 'maximized'
      expandFull()
    } else {
      state = 'open'
      applyOpen()
    }
  })
})()
