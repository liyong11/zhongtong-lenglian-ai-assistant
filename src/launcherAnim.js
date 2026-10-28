// 悬浮球待机动画：呼吸浮沉 + 随机小动作 + 跳水/喷水（含粒子）；嵌入场景大动作临时扩框
export function createLauncherAnim(options) {
  const { getMark, getLauncher, embedded, parentOrigin, canAnim, setAnimPos, clearAnimPos, setBlink } = options
  let timer = 0
  let acting = false
  let lastName = ''
  const particles = new Set()
  const mark = () => getMark()
  const launcher = () => getLauncher()

  // 动作池（权重）；dive/spout 大动作略高频，睡觉/翻滚/跳跃等丰富待机
  const POOL = [
    ['sway', 1], ['swim', 1], ['wiggle', 1],
    ['roll', 1], ['jump', 1], ['greet', 0.8],
    ['sleep', 1.2], ['circle', 1], ['chase', 1],
    ['happy', 1], ['peek', 0.9],
    ['dive', 1.4], ['spout', 1],
  ]
  function pickName() {
    const pool = POOL.filter(([n]) => n !== lastName)
    const total = pool.reduce((s, [, w]) => s + w, 0)
    let r = Math.random() * total
    for (const [n, w] of pool) { r -= w; if (r <= 0) return n }
    return 'sway'
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (canAnim() && !acting && !document.hidden) await playRandom()
      schedule()
    }, 3600 + Math.random() * 3200)
  }

  async function playRandom() {
    const name = pickName()
    lastName = name
    acting = true
    const m = mark()
    if (m) m.classList.add('acting')
    try {
      if (name === 'dive' || name === 'spout') {
        await expandFor(name)
        await (name === 'dive' ? dive() : spout())
        collapse()
      } else {
        await runAction(name)
        // 15% 概率追加一个不同的小动作（连击，更生动）
        if (Math.random() < 0.15) {
          const extra = ['sway', 'swim', 'wiggle', 'jump', 'roll'][Math.floor(Math.random() * 5)]
          if (extra !== name) await runAction(extra)
        }
      }
    } catch { /* 动画中断忽略 */ }
    acting = false
    const m2 = mark()
    if (m2) m2.classList.remove('acting')
  }

  function runAction(name) {
    const m = mark()
    if (!m) return Promise.resolve()
    switch (name) {
      case 'roll': return roll(m)
      case 'jump': return jump(m)
      case 'greet': return greet(m)
      case 'sleep': return sleepAnim(m)
      case 'circle': return circleSwim(m)
      case 'chase': return chaseBubble(m)
      case 'happy': return happyJump(m)
      case 'peek': return peek(m)
      default: return smallAnim(name)
    }
  }

  function smallAnim(name) {
    const m = mark()
    if (!m) return Promise.resolve()
    const K = {
      sway: [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-9deg)' }, { transform: 'rotate(8deg)' }, { transform: 'rotate(-6deg)' }, { transform: 'rotate(0deg)' }],
      swim: [{ transform: 'translate(0,0)' }, { transform: 'translate(5px,-4px)' }, { transform: 'translate(-5px,3px)' }, { transform: 'translate(3px,2px)' }, { transform: 'translate(0,0)' }],
      wiggle: [{ transform: 'rotate(0deg) skewX(0deg)' }, { transform: 'rotate(-6deg) skewX(-6deg)' }, { transform: 'rotate(6deg) skewX(6deg)' }, { transform: 'rotate(-5deg) skewX(-4deg)' }, { transform: 'rotate(0deg) skewX(0deg)' }],
    }
    return m.animate(K[name] || K.sway, { duration: name === 'wiggle' ? 750 : 1300, easing: 'ease-in-out' }).finished.catch(() => {})
  }

  // ---- 翻滚 / 跳跃 / 打招呼 / 转圈游 / 捉迷藏 ----
  function roll(m) {
    return m.animate([
      { transform: 'rotate(0deg) translateY(0)' },
      { transform: 'rotate(180deg) translateY(-14px)', offset: 0.5 },
      { transform: 'rotate(360deg) translateY(0)' },
    ], { duration: 1000, easing: 'ease-in-out' }).finished.catch(() => {})
  }
  function jump(m) {
    return m.animate([
      { transform: 'translateY(0) scale(1,1)' },
      { transform: 'translateY(4px) scale(1.05,.92)', offset: 0.18 },
      { transform: 'translateY(-26px) scale(.96,1.05)', offset: 0.5 },
      { transform: 'translateY(0) scale(1,1)' },
    ], { duration: 750, easing: 'ease-out' }).finished.catch(() => {})
  }
  function greet(m) {
    return m.animate([
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(-15deg)', offset: 0.3 },
      { transform: 'rotate(-15deg)', offset: 0.6 },
      { transform: 'rotate(0deg)' },
    ], { duration: 1100, easing: 'ease-in-out' }).finished.catch(() => {})
  }
  function circleSwim(m) {
    const frames = []
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2
      frames.push({ transform: `translate(${Math.cos(a) * 7}px,${Math.sin(a) * 4}px)` })
    }
    return m.animate(frames, { duration: 1500, easing: 'linear' }).finished.catch(() => {})
  }
  function peek(m) {
    return m.animate([
      { transform: 'translateY(0)', opacity: 1 },
      { transform: 'translateY(22px)', opacity: 0.45, offset: 0.3 },
      { transform: 'translateY(22px)', opacity: 0.45, offset: 0.55 },
      { transform: 'translateY(-6px)', opacity: 1, offset: 0.8 },
      { transform: 'translateY(0)', opacity: 1 },
    ], { duration: 1500, easing: 'ease-in-out' }).finished.catch(() => {})
  }

  // ---- 文本粒子（Zzz / 星星 / 气泡）与睡觉 / 开心 / 追气泡 ----
  function spawnText(x, y, text, opts = {}) {
    const host = launcher()
    if (!host) return
    const s = document.createElement('span')
    s.className = 'anim-particle anim-text'
    s.textContent = text
    s.style.cssText = `left:${x}px;top:${y}px;color:${opts.color || '#7db9e8'};font-size:${opts.size || 13}px;`
    host.appendChild(s)
    particles.add(s)
    const anim = s.animate(opts.frames || [
      { transform: 'translate(0,0) scale(.7)', opacity: 0 },
      { transform: `translate(${opts.dx ?? 8}px,${opts.dy ?? -26}px) scale(1.15)`, opacity: 1, offset: 0.35 },
      { transform: `translate(${(opts.dx ?? 8) * 1.6}px,${(opts.dy ?? -26) * 1.8}px) scale(1)`, opacity: 0 },
    ], { duration: opts.duration || 1100, easing: 'ease-out', fill: 'forwards' })
    anim.finished.catch(() => {}).then(() => { s.remove(); particles.delete(s) })
  }
  function sleepAnim(m) {
    if (setBlink) setBlink('blink') // 闭眼睡觉
    for (let i = 0; i < 3; i++) {
      setTimeout(() => spawnText(40, 6, 'Z', { size: 12 + i * 3, dx: 12, dy: -20, duration: 1500 }), i * 600)
    }
    return new Promise(r => setTimeout(() => { if (setBlink) setBlink(''); r() }, 2400))
  }
  function happyJump(m) {
    if (setBlink) setBlink('blink') // 弯月笑眼
    spawnText(6, 6, '✦', { color: '#ffd66b', size: 13, dx: -12, dy: -18 })
    spawnText(52, 10, '✦', { color: '#ffd66b', size: 11, dx: 12, dy: -20 })
    const a = m.animate([
      { transform: 'translateY(0)' },
      { transform: 'translateY(-13px)', offset: 0.3 },
      { transform: 'translateY(0)', offset: 0.55 },
      { transform: 'translateY(-9px)', offset: 0.78 },
      { transform: 'translateY(0)' },
    ], { duration: 800, easing: 'ease-out' }).finished.catch(() => {})
    return a.then(() => { if (setBlink) setBlink('') })
  }
  function chaseBubble(m) {
    spawnText(52, 2, '○', { color: 'rgba(150,220,255,.9)', size: 12, dx: 6, dy: -30, duration: 1300 })
    return m.animate([
      { transform: 'rotate(0deg) translate(0,0)' },
      { transform: 'rotate(10deg) translate(5px,-3px)', offset: 0.35 },
      { transform: 'rotate(10deg) translate(6px,-6px)', offset: 0.6 },
      { transform: 'rotate(0deg) translate(0,0)' },
    ], { duration: 1300, easing: 'ease-in-out' }).finished.catch(() => {})
  }

  function spawnParticle(x, y, opts) {
    const host = launcher()
    if (!host) return
    const s = document.createElement('span')
    s.className = 'anim-particle'
    const size = opts.size || 6
    s.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;background:${opts.color};`
    host.appendChild(s)
    particles.add(s)
    const anim = s.animate(opts.frames, { duration: opts.duration || 700, easing: opts.easing || 'ease-out', fill: 'forwards' })
    anim.finished.catch(() => {}).then(() => { s.remove(); particles.delete(s) })
  }
  function splash(x, y, n = 7, color = 'rgba(120,200,255,.9)') {
    for (let i = 0; i < n; i++) {
      const dist = 26 + Math.random() * 34
      const dx = (Math.random() - 0.5) * 2 * dist
      const dy = -(12 + Math.random() * 30)
      spawnParticle(x, y, {
        color, size: 4 + Math.random() * 4,
        frames: [
          { transform: 'translate(0,0) scale(1)', opacity: 1 },
          { transform: `translate(${dx}px,${dy + 22}px) scale(.5)`, opacity: 0 },
        ],
        duration: 550 + Math.random() * 300,
      })
    }
  }
  function bubbles(x, y, n = 6) {
    for (let i = 0; i < n; i++) {
      const dx = (Math.random() - 0.5) * 36
      const dy = -(50 + Math.random() * 50)
      const size = 4 + Math.random() * 5
      setTimeout(() => spawnParticle(x, y, {
        color: 'rgba(150,220,255,.85)', size,
        frames: [
          { transform: 'translate(0,0) scale(.4)', opacity: 0 },
          { transform: `translate(${dx * 0.4}px,${dy * 0.5}px) scale(1)`, opacity: 1, offset: 0.4 },
          { transform: `translate(${dx}px,${dy}px) scale(.8)`, opacity: 0 },
        ],
        duration: 800 + Math.random() * 400,
      }), i * 90)
    }
  }

  async function dive() {
    const m = mark()
    if (!m) return
    const rect = launcher().getBoundingClientRect()
    const cx = rect.width / 2, cy = rect.height / 2
    await m.animate([{ transform: 'translateY(0) scale(1,1)' }, { transform: 'translateY(5px) scale(1.06,.9)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {})
    splash(cx, cy + 10, 8)
    await m.animate([{ transform: 'translateY(5px) scale(1.06,.9)', opacity: 1 }, { transform: 'translateY(95px) scale(.6)', opacity: 0 }], { duration: 420, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {})
    splash(cx, cy + 6, 6, 'rgba(180,230,255,.9)')
    await m.animate([{ transform: 'translateY(95px) scale(.6)', opacity: 0 }, { transform: 'translateY(-34px) scale(1.02) rotate(-14deg)', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }).finished.catch(() => {})
    await m.animate([{ transform: 'translateY(-34px) scale(1.02) rotate(-14deg)' }, { transform: 'translateY(0) scale(1) rotate(0deg)' }], { duration: 300, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {})
    m.getAnimations().forEach(a => a.cancel())
  }

  async function spout() {
    const m = mark()
    if (!m) return
    const rect = launcher().getBoundingClientRect()
    m.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-5deg)' }, { transform: 'rotate(4deg)' }, { transform: 'rotate(0deg)' }], { duration: 900, easing: 'ease-in-out' })
    bubbles(rect.width / 2, 6, 7)
    await new Promise(r => setTimeout(r, 1000))
  }

  function expandFor(name) {
    if (!embedded) return Promise.resolve()
    const W = name === 'dive' ? 200 : 160
    const H = name === 'dive' ? 250 : 210
    const ax = (W - 64) / 2
    const ay = H - 64 - 18
    return new Promise(resolve => {
      const onMsg = e => {
        const d = e.data
        if (d && d.source === 'zto-ai-widget' && d.type === 'anim-expanded') {
          window.removeEventListener('message', onMsg)
          setAnimPos({ left: d.ax, bottom: d.H - d.ay - 64 })
          resolve()
        }
      }
      window.addEventListener('message', onMsg)
      window.parent.postMessage({ source: 'zto-ai-widget', type: 'anim-expand', w: W, h: H, ax, ay }, parentOrigin)
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve() }, 500)
    })
  }
  function collapse() {
    if (!embedded) return
    clearAnimPos()
    window.parent.postMessage({ source: 'zto-ai-widget', type: 'anim-collapse' }, parentOrigin)
  }

  return {
    start() { const m = mark(); if (m) m.classList.add('bob'); schedule() },
    stop() {
      clearTimeout(timer)
      const m = mark()
      if (m) { m.classList.remove('bob'); m.getAnimations().forEach(a => a.cancel()) }
      particles.forEach(p => p.remove())
      particles.clear()
    },
  }
}
