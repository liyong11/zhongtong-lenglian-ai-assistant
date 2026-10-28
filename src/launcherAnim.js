// 悬浮球待机动画：呼吸浮沉 + 随机小动作 + 跳水/喷水（含粒子）；嵌入场景大动作临时扩框
export function createLauncherAnim(options) {
  const { getMark, getLauncher, embedded, parentOrigin, canAnim, setAnimPos, clearAnimPos } = options
  let timer = 0
  let acting = false
  const particles = new Set()
  const mark = () => getMark()
  const launcher = () => getLauncher()

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (canAnim() && !acting && !document.hidden) await playRandom()
      schedule()
    }, 4200 + Math.random() * 3600)
  }

  async function playRandom() {
    const pool = ['sway', 'swim', 'wiggle', 'sway', 'swim', 'dive', 'spout']
    const name = pool[Math.floor(Math.random() * pool.length)]
    acting = true
    const m = mark()
    if (m) m.classList.add('acting')
    try {
      if (name === 'dive' || name === 'spout') {
        await expandFor(name)
        await (name === 'dive' ? dive() : spout())
        collapse()
      } else {
        await smallAnim(name)
      }
    } catch { /* 动画中断忽略 */ }
    acting = false
    const m2 = mark()
    if (m2) m2.classList.remove('acting')
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
