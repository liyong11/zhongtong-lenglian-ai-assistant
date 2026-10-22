(() => {
  if (document.querySelector('iframe[data-zto-ai-widget]')) return
  const script = document.currentScript
  if (!script) return
  const serviceOrigin = new URL(script.src).origin
  const side = script.dataset.position === 'left' ? 'left' : 'right'
  const sideGap = Number(script.dataset.side) || 24
  const bottomGap = Number(script.dataset.bottom) || 24
  const LAUNCHER_SIZE = 80
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
    [side]: `${sideGap}px`,
    bottom: `${bottomGap}px`,
    width: '80px',
    height: '80px',
    border: '0',
    background: 'transparent',
    zIndex: script.dataset.zIndex || '2147483000',
  })
  document.body.appendChild(frame)

  // ---------- 悬浮球位置：拖动后以宿主页面坐标记忆（每个嵌入站点各自记住），null = script 标签配置的默认角落 ----------
  let launcherPos = loadPos()
  applyLauncherPos()

  function loadPos() {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.bottom)) return saved
    } catch { /* 隐私模式/无记忆：走默认角落 */ }
    return null
  }
  function clampPos(left, bottom) {
    const vw = window.innerWidth, vh = window.innerHeight
    return {
      left: Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - LAUNCHER_SIZE - MARGIN)),
      bottom: Math.min(Math.max(bottom, MARGIN), Math.max(MARGIN, vh - LAUNCHER_SIZE - MARGIN)),
    }
  }
  function applyLauncherPos() {
    frame.style.top = 'auto'
    frame.style.transition = 'none'
    if (launcherPos) {
      launcherPos = clampPos(launcherPos.left, launcherPos.bottom)
      frame.style.left = `${launcherPos.left}px`
      frame.style.right = 'auto'
      frame.style.bottom = `${launcherPos.bottom}px`
    } else {
      frame.style.left = side === 'left' ? `${sideGap}px` : 'auto'
      frame.style.right = side === 'right' ? `${sideGap}px` : 'auto'
      frame.style.bottom = `${bottomGap}px`
    }
  }
  // 视口变化（缩放/旋转/窗口调整）后重新钳位，避免记忆位置或聊天窗落到屏幕外
  let widgetState = 'collapsed' // 'collapsed'（悬浮球）| 'open'（聊天窗）| 'maximized'
  let lastOpenPos = null // 最近一次展开态位置：最大化还原时回到原位，而不是以全屏 rect 为锚
  window.addEventListener('resize', () => {
    if (widgetState === 'collapsed') {
      if (launcherPos) applyLauncherPos()
    } else if (widgetState === 'open') {
      // 聊天窗按展开尺寸重新钳位，保持完整可见
      const vw = window.innerWidth, vh = window.innerHeight
      const width = Math.min(760, vw - 32), height = Math.min(660, vh - 32)
      const rect = frame.getBoundingClientRect()
      frame.style.left = `${Math.min(Math.max(rect.left, MARGIN), Math.max(MARGIN, vw - width - MARGIN))}px`
      frame.style.right = 'auto'
      frame.style.bottom = `${Math.min(Math.max(vh - rect.top - rect.height, MARGIN), Math.max(MARGIN, vh - height - MARGIN))}px`
    }
    // maximized 铺满视口，无需处理
  })

  // ---------- 悬浮球拖动：iframe 内 pointer capture 独占事件流，逐帧转发屏幕坐标 ----------
  // 指针按下发生在 iframe 文档内且被 capture 独占，父页面拿不到原生事件；
  // screenX/screenY 相对屏幕、与 iframe 自身位置无关，用它做锚定逐帧定位，
  // 不存在"坐标系随拖动移动"的反馈漂移，也不在拖动中途改动 iframe 尺寸。
  let drag = null // { startLeft, startBottom, s0: { x, y }, moved }
  function onDragStart(sX, sY) {
    if (drag) return
    const rect = frame.getBoundingClientRect()
    drag = {
      startLeft: rect.left,
      startBottom: window.innerHeight - rect.top - rect.height,
      s0: { x: sX, y: sY },
      moved: false,
    }
    frame.style.transition = 'none'
  }
  function onDragMove(sX, sY) {
    if (!drag) return
    drag.moved = true
    launcherPos = clampPos(
      drag.startLeft + sX - drag.s0.x,
      drag.startBottom - (sY - drag.s0.y),
    )
    frame.style.top = 'auto'
    frame.style.left = `${launcherPos.left}px`
    frame.style.right = 'auto'
    frame.style.bottom = `${launcherPos.bottom}px`
  }
  function onDragEnd() {
    if (!drag) return
    const moved = drag.moved
    drag = null
    if (!moved) return // 轻点误触阈值：位置未动，不吸附不记忆
    if (!launcherPos) return
    // 吸附到更近的左右边缘，钳位后存入宿主域 localStorage
    const snapLeft = launcherPos.left + LAUNCHER_SIZE / 2 <= window.innerWidth / 2
      ? MARGIN
      : window.innerWidth - LAUNCHER_SIZE - MARGIN
    launcherPos = clampPos(snapLeft, launcherPos.bottom)
    try { localStorage.setItem(POS_KEY, JSON.stringify(launcherPos)) } catch { /* 隐私模式：本次会话内仍生效 */ }
    // 吸附落位用短过渡，之后移除避免影响展开/收起
    frame.style.transition = 'left .22s ease, bottom .22s ease'
    frame.style.left = `${launcherPos.left}px`
    frame.style.bottom = `${launcherPos.bottom}px`
    setTimeout(() => { frame.style.transition = 'none' }, 250)
  }

  window.addEventListener('message', event => {
    if (event.origin !== serviceOrigin || event.source !== frame.contentWindow) return
    const message = event.data
    if (!message || message.source !== 'zto-ai-widget') return
    if (message.type === 'launcher-drag') {
      if (message.state === 'start') onDragStart(message.sX, message.sY)
      else if (message.state === 'move') onDragMove(message.sX, message.sY)
      else if (message.state === 'end') onDragEnd()
      return
    }
    if (message.type !== 'resize') return
    const wasMaximized = widgetState === 'maximized'
    if (message.state === 'collapsed') {
      widgetState = 'collapsed'
      frame.style.width = '80px'
      frame.style.height = '80px'
      applyLauncherPos()
    } else if (message.state === 'maximized') {
      widgetState = 'maximized'
      Object.assign(frame.style, { top: '0', left: '0', right: '0', bottom: '0', width: '100vw', height: '100vh' })
    } else {
      widgetState = 'open'
      // 展开：锚定悬浮球当前位置；从最大化还原时回到上次展开位置
      const vw = window.innerWidth, vh = window.innerHeight
      const width = Math.min(760, vw - 32), height = Math.min(660, vh - 32)
      let left, bottom
      if (wasMaximized && lastOpenPos) {
        left = lastOpenPos.left
        bottom = lastOpenPos.bottom
      } else {
        const rect = frame.getBoundingClientRect()
        left = Math.min(Math.max(rect.left, MARGIN), Math.max(MARGIN, vw - width - MARGIN))
        bottom = Math.min(Math.max(vh - rect.top - rect.height, MARGIN), Math.max(MARGIN, vh - height - MARGIN))
        lastOpenPos = { left, bottom }
      }
      frame.style.transition = 'none'
      frame.style.top = 'auto'
      frame.style.left = `${left}px`
      frame.style.right = 'auto'
      frame.style.bottom = `${bottom}px`
      frame.style.width = 'min(760px, calc(100vw - 32px))'
      frame.style.height = 'min(660px, calc(100vh - 32px))'
    }
  })
})()
