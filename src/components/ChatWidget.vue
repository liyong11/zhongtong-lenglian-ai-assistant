<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { renderMessage } from '../renderMessage.mjs'
import { consumeSseStream } from '../streamResponse.mjs'

const params = new URLSearchParams(location.search)
// 名称优先级：嵌入方显式传参 title > 后台「机器人形象」配置 > 默认“小冷”
const urlTitle = params.get('title') || ''
const embedded = window.parent !== window
const parentOrigin = (() => {
  try { return document.referrer ? new URL(document.referrer).origin : '*' }
  catch { return '*' }
})()

const open = ref(false)
const maximized = ref(false)
const loading = ref(false)
const online = ref(false)
const input = ref('')
const sessionId = ref(null)
const messages = ref([])
const sidebar = ref({ onDuty: { byDate: {}, byWeekday: {} }, faq: [] })
const messageList = ref(null)
const imagePreview = ref('')
let imageClickListener = null

// 全屏/移动端整页嵌入（?mode=full）：直接展开对话窗铺满容器，隐藏最小化/关闭（关掉会让 iframe 空白）
const full = params.get('mode') === 'full'

// 每 30 秒跳动一次，让“今日值班”跨零点后能重新计算
const nowTick = ref(Date.now())
let clockTimer = 0
const today = computed(() => {
  const now = new Date(nowTick.value)
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
  const weekday = `周${'日一二三四五六'[now.getDay()]}`
  const duty = sidebar.value.onDuty || {}
  return { date, weekday, staff: duty.byDate?.[date] || duty.byWeekday?.[weekday] || [] }
})
const quickQuestions = computed(() => (sidebar.value.faq || []).slice(0, 5))
// 常用下载（后台「下载汇总」配置）：条目只放一个下载按钮，点击弹出「扫码 / 直链」下载弹窗；
// 弹窗内容仍受后台方式勾选控制，旧数据无字段默认两种都展示
const downloads = computed(() => (sidebar.value.downloads || []).filter(item => item && item.name))
const hasMethod = (item, method) => !Array.isArray(item.methods) || item.methods.includes(method)
const dlPreview = ref(null)
const dlQrImage = ref('')
async function openDownload(item) {
  if (!item.url) return
  dlPreview.value = item
  dlQrImage.value = ''
  if (!hasMethod(item, 'qr')) return
  try {
    const QRCode = await import('qrcode')
    dlQrImage.value = await QRCode.toDataURL(item.url, { width: 512, margin: 2, color: { dark: '#0f1f2d' } })
  } catch { /* 生成失败时弹窗内隐藏二维码区，保留直链按钮 */ }
}
function closeDownload() {
  dlPreview.value = null
  dlQrImage.value = ''
}

// 机器人形象：名称与头像（头像为图片 URL 时渲染图片，否则渲染文字/表情）
const title = computed(() => urlTitle || sidebar.value.brand?.name || '小冷')
const avatar = computed(() => String(sidebar.value.brand?.avatar || '').trim())
const avatarIsImage = computed(() => /^(https?:|data:image|\/uploads\/)/i.test(avatar.value))
const avatarText = computed(() => avatar.value || 'AI')
// 悬浮按钮图：单独配置时优先，否则沿用头像
const launcher = computed(() => String(sidebar.value.brand?.launcher || '').trim())
const launcherIsImage = computed(() => /^(https?:|data:image|\/uploads\/)/i.test(launcher.value) || (!launcher.value && avatarIsImage.value))
const launcherImage = computed(() => launcher.value || avatar.value)
const launcherText = computed(() => launcher.value || avatarText.value)

// 人员钉钉号映射：{ 姓名: 钉钉号 }，配置后点击姓名可唤起钉钉单聊
const staffMap = computed(() => {
  const map = {}
  for (const item of sidebar.value.staff || []) {
    if (item?.name && item?.dingtalkId) map[item.name] = item.dingtalkId
  }
  return map
})
function dingtalkLink(name) {
  const id = staffMap.value[name]
  return id ? `dingtalk://dingtalkclient/action/sendmsg?dingtalk_id=${encodeURIComponent(id)}` : ''
}

function notify(state) {
  if (!embedded) return
  if (state === 'collapsed') {
    // 收回小框：球回到 CSS 默认位置（由外层 iframe 定位决定），下次按下重新展开
    launcherPos.value = null
    expandReady = false
  }
  window.parent.postMessage({ source: 'zto-ai-widget', type: 'resize', state }, parentOrigin)
}

// ---------- 悬浮球拖动：按住拖换位、松手吸附左右边缘并记忆；位移小于阈值视为点击 ----------
// 嵌入模式：pointerdown 即请外层把 iframe 展开为全屏透明层（expand 回告后坐标系=宿主视口），
// 拖动全程在 iframe 内部原生进行（无跨文档逐帧转发，零延迟零漂移）；松手吸附后上报球位并收回小框。
const LAUNCHER_SIZE = 64
const LAUNCHER_MARGIN = 8
const launcherEl = ref(null)
const launcherPos = ref(null) // { left, bottom }；null 时走 CSS 默认位置
const launcherDragging = ref(false)
let launcherDrag = null
let launcherClickSuppressed = false
let expandReady = false // 嵌入模式：外层已把 iframe 展开为全屏，可在内部原生拖动
let expandListener = null
const launcherStyle = computed(() => launcherPos.value
  ? { left: `${launcherPos.value.left}px`, right: 'auto', bottom: `${launcherPos.value.bottom}px` }
  : null)
function clampLauncher(left, bottom) {
  return {
    left: Math.min(Math.max(left, LAUNCHER_MARGIN), window.innerWidth - LAUNCHER_SIZE - LAUNCHER_MARGIN),
    bottom: Math.min(Math.max(bottom, LAUNCHER_MARGIN), window.innerHeight - LAUNCHER_SIZE - LAUNCHER_MARGIN),
  }
}
function onLauncherDown(event) {
  if (launcherDrag || (event.pointerType === 'mouse' && event.button !== 0)) return
  launcherClickSuppressed = false // 新手势开始：清除上次拖动遗留的点击抑制，避免吞掉正常点击
  const rect = launcherEl.value.getBoundingClientRect()
  launcherDrag = {
    startX: event.clientX,
    startY: event.clientY,
    offsetInX: event.clientX - rect.left,
    offsetInY: event.clientY - rect.top,
    moved: false,
  }
  try { launcherEl.value.setPointerCapture(event.pointerId) } catch { /* 合成事件无活动 pointer：拖拽逻辑照常 */ }
}
function onLauncherMove(event) {
  if (!launcherDrag) return
  if (!launcherDrag.moved && Math.hypot(event.clientX - launcherDrag.startX, event.clientY - launcherDrag.startY) < 5) return
  if (!launcherDrag.moved) {
    launcherDrag.moved = true
    launcherDragging.value = true
    if (embedded) {
      // 真正开始拖动才请外层展开全屏（点击路径不展开，无闪烁）；expand 回告后首帧按指针位置补偿
      expandReady = false
      window.parent.postMessage({ source: 'zto-ai-widget', type: 'prepare' }, parentOrigin)
    }
  }
  if (embedded && !expandReady) return // 等 expand 回告
  const pos = clampLauncher(event.clientX - launcherDrag.offsetInX, window.innerHeight - (event.clientY - launcherDrag.offsetInY) - LAUNCHER_SIZE)
  launcherPos.value = pos
}
function onLauncherUp() {
  if (!launcherDrag) return
  const moved = launcherDrag.moved
  launcherDrag = null
  if (!moved) return // 原地松手：交给 click 打开对话
  launcherClickSuppressed = true
  if (!launcherPos.value) { launcherDragging.value = false; return } // expand 未到达即松手：位置未变，仅抑制误点击
  // 吸附到更近的左右边缘：先保持 dragging（无过渡）落位，再去掉类让吸附平滑动画
  const snapLeft = launcherPos.value.left + LAUNCHER_SIZE / 2 <= window.innerWidth / 2
    ? LAUNCHER_MARGIN
    : window.innerWidth - LAUNCHER_SIZE - LAUNCHER_MARGIN
  launcherPos.value = { ...launcherPos.value, left: snapLeft }
  if (embedded) {
    // 上报最终球位（外层存宿主域并收回 80×80 小框），随后复位待机状态
    window.parent.postMessage({ source: 'zto-ai-widget', type: 'launcher-pos', left: launcherPos.value.left, bottom: launcherPos.value.bottom }, parentOrigin)
    notify('collapsed')
  } else {
    try { localStorage.setItem('zto-launcher-pos', JSON.stringify(launcherPos.value)) } catch {}
  }
  requestAnimationFrame(() => { launcherDragging.value = false })
}
function onLauncherClick() {
  if (launcherClickSuppressed) { launcherClickSuppressed = false; return }
  openChat()
}
function restoreLauncherPos(attempt = 0) {
  // 嵌入模式：悬浮球位置由外层 embed.js 记忆与移动，iframe 内保持默认右下角
  if (embedded) return
  // 视口尚未就绪（如隐藏面板加载）时钳位会得到负坐标，延迟重试
  if (window.innerWidth < 200 || window.innerHeight < 200) {
    if (attempt < 5) setTimeout(() => restoreLauncherPos(attempt + 1), 300)
    return
  }
  try {
    const saved = JSON.parse(localStorage.getItem('zto-launcher-pos') || 'null')
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.bottom)) {
      launcherPos.value = clampLauncher(saved.left, saved.bottom)
    }
  } catch { /* 无记忆或隐私模式：走默认右下角 */ }
}
function openChat() {
  open.value = true
  if (!messages.value.length) messages.value.push(makeWelcome())
  notify(maximized.value ? 'maximized' : 'open')
}
// 欢迎消息：文本下内嵌「常用下载 / 常见问题」可点按钮（welcome 标记驱动模板渲染）
function makeWelcome(text = `你好，我是${title.value}。可以问我订单查询、异常处理和操作指引。`) {
  return { role: 'assistant', content: text, welcome: true }
}
function minimize() {
  open.value = false
  notify('collapsed')
}
function closeChat() {
  open.value = false
  maximized.value = false
  notify('collapsed')
}
function toggleMaximize() {
  maximized.value = !maximized.value
  notify(maximized.value ? 'maximized' : 'open')
}
function resetChat() {
  messages.value = [makeWelcome(`你好，我是${title.value}。新的对话已开始。`)]
  sessionId.value = null
}
async function scrollToBottom() {
  await nextTick()
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight
}
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
function startAnswerAnimation(answer) {
  if (reduceMotion) {
    answer.displayContent = answer.content
    if (answer.done) answer.pending = false
    return
  }
  if (answer.animationId) return
  const tick = () => {
    const full = Array.from(answer.content)
    const visible = Array.from(answer.displayContent)
    const gap = full.length - visible.length
    if (gap > 0) {
      const step = Math.min(gap, Math.max(1, Math.ceil(gap / 24)))
      answer.displayContent += full.slice(visible.length, visible.length + step).join('')
    }
    if (answer.done && answer.displayContent === answer.content) {
      answer.pending = false
      answer.animationId = 0
      return
    }
    // 用 setTimeout 而非 rAF 驱动：rAF 在隐藏 iframe/后台标签中会完全暂停，回复会永远停在打字动画
    answer.animationId = setTimeout(tick, 16)
  }
  answer.animationId = setTimeout(tick, 16)
}
function chunkText(data) {
  if (typeof data?.text === 'string') return data.text
  if (typeof data?.content === 'string') return data.content
  return ''
}

// ---------- 生成过程状态：真实进度（思考流来自应用 thoughts，不再用定时器模拟步骤） ----------
async function send(question = input.value) {
  const prompt = String(question || '').trim()
  if (!prompt || loading.value) return
  input.value = ''
  messages.value.push({ role: 'user', content: prompt })
  const history = messages.value
    .filter(message => message.content && (message.role === 'user' || message.role === 'assistant'))
    .map(message => ({ role: message.role, content: message.content }))
  const answer = { role: 'assistant', content: '', displayContent: '', pending: true, done: false, animationId: 0, thought: '', thoughtOpen: false }
  messages.value.push(answer)
  startAnswerAnimation(answer)
  loading.value = true
  await scrollToBottom()

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, session_id: sessionId.value, messages: history }),
    })
    if (!response.ok || !response.body) throw new Error(`服务请求失败（${response.status}）`)
    let streamError = ''
    await consumeSseStream(response.body, async ({ event, data }) => {
      if (event === 'thought') {
        answer.thought = data.replace ? (data.text || '') : answer.thought + (data.text || '')
        if (!answer.content) answer.thoughtOpen = true
      }
      if (event === 'chunk') {
        // replace：代理发现之前下发的文本其实是规划叙述（检索边界回滚），整段重置
        if (data.replace) {
          answer.content = typeof data.text === 'string' ? data.text : ''
          if (answer.displayContent.length > answer.content.length) answer.displayContent = answer.content
        } else {
          answer.content += chunkText(data)
        }
        if (data.session_id) sessionId.value = data.session_id
        if (!data.replace && answer.thoughtOpen) answer.thoughtOpen = false
      }
      if (event === 'done' && data.session_id) sessionId.value = data.session_id
      if (event === 'error') streamError = data.error || 'AI 服务异常'
      await scrollToBottom()
    })
    if (streamError) throw new Error(streamError)
    if (!answer.content) answer.content = '暂时没有获取到回复，请稍后重试。'
  } catch (error) {
    answer.content = `请求失败：${error.message}`
  } finally {
    answer.done = true
    startAnswerAnimation(answer)
    loading.value = false
    await scrollToBottom()
  }
}

onMounted(async () => {
  clockTimer = setInterval(() => { nowTick.value = Date.now() }, 30 * 1000)
  restoreLauncherPos()
  if (full) openChat()
  notify('collapsed')
  // 嵌入模式：外层展开全屏后回告球当前位置，重锚后开始内部原生拖动
  if (embedded) {
    expandListener = (event) => {
      if (event.source !== window.parent) return
      const m = event.data
      if (!m || m.source !== 'zto-ai-widget' || m.type !== 'expand') return
      launcherPos.value = { left: m.ballLeft, bottom: window.innerHeight - m.ballTop - LAUNCHER_SIZE }
      expandReady = true
    }
    window.addEventListener('message', expandListener)
  }
  // 回答里的图片点击放大预览（v-html 内容无法直接绑定，走事件委托）
  imageClickListener = (event) => {
    if (event.target instanceof HTMLElement && event.target.classList.contains('message-image')) {
      imagePreview.value = event.target.getAttribute('src') || ''
    }
  }
  document.addEventListener('click', imageClickListener)
  try {
    const [ping, config] = await Promise.all([fetch('/api/ping'), fetch('/api/sidebar')])
    const pingData = await ping.json()
    online.value = pingData.configured === true
    const data = await config.json()
    if (data.success) sidebar.value = data.config || sidebar.value
  } catch { online.value = false }
})
onUnmounted(() => {
  clearInterval(clockTimer)
  if (imageClickListener) document.removeEventListener('click', imageClickListener)
  if (expandListener) window.removeEventListener('message', expandListener)
})
</script>

<template>
  <div class="widget-root" :class="{ embedded, maximized, full }">
    <button v-if="!open" ref="launcherEl" class="launcher" :class="{ dragging: launcherDragging }" :style="launcherStyle" type="button" aria-label="打开智能助理" @pointerdown="onLauncherDown" @pointermove="onLauncherMove" @pointerup="onLauncherUp" @pointercancel="onLauncherUp" @lostpointercapture="onLauncherUp" @click="onLauncherClick">
      <span class="launcher-mark"><img v-if="launcherIsImage" :src="launcherImage" alt="" draggable="false"><template v-else>{{ launcherText }}</template></span>
      <span class="launcher-pulse" />
    </button>

    <section v-else class="chat-window" :class="{ maximized }" aria-label="智能助理对话窗口">
      <header class="chat-header">
        <div class="bot-identity">
          <span class="bot-avatar"><img v-if="avatarIsImage" :src="avatar" alt=""><template v-else>{{ avatarText }}</template></span>
          <span><b>{{ title }}</b><small><i :class="{ online }" />{{ online ? '服务正常' : '服务未配置' }}</small></span>
        </div>
        <!-- 今日技术支持：从侧栏上移到标题栏，人名可点发起钉钉单聊 -->
        <div v-if="today.staff.length" class="header-duty">
          <span class="header-duty-label">今日技术支持</span>
          <div class="header-duty-staff">
            <template v-for="name in today.staff" :key="name">
              <a v-if="dingtalkLink(name)" :href="dingtalkLink(name)" class="staff-ding" :title="`钉钉联系${name}`" :aria-label="`钉钉联系${name}`" @click.stop>{{ name }}</a>
              <span v-else class="header-duty-name">{{ name }}</span>
            </template>
          </div>
        </div>
        <div class="window-actions">
          <button type="button" title="新对话" aria-label="新对话" @click="resetChat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
          <button v-if="!full" type="button" title="最小化" aria-label="最小化" @click="minimize">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button v-if="!full" type="button" :title="maximized ? '还原' : '最大化'" :aria-label="maximized ? '还原' : '最大化'" @click="toggleMaximize">
            <svg v-if="!maximized" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          </button>
          <button type="button" title="关闭" aria-label="关闭" @click="closeChat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </header>

      <div class="chat-layout">
        <aside class="chat-aside">
          <div v-if="downloads.length" class="aside-card">
            <span class="eyebrow">常用下载</span>
            <div class="download-list">
              <div v-for="item in downloads" :key="item.name" class="download-item" :class="{ pending: !item.url }">
                <span class="download-name" :title="item.url ? item.name : '链接待配置'">{{ item.name }}</span>
                <button v-if="item.url" type="button" class="download-act" title="下载" :aria-label="`下载${item.name}`" @click="openDownload(item)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg>
                </button>
              </div>
            </div>
          </div>
          <div class="aside-card grow">
            <span class="eyebrow">常见问题</span>
            <button v-for="item in quickQuestions" :key="item.q" type="button" class="quick-link" @click="send(item.q)">{{ item.q }}<span>›</span></button>
          </div>
        </aside>

        <main class="conversation">
          <div v-if="today.staff.length" class="mobile-duty">
            <span class="mobile-duty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
            </span>
            <span class="mobile-duty-label">今日值班</span>
            <div class="mobile-duty-staff">
              <template v-for="name in today.staff" :key="name">
                <a v-if="dingtalkLink(name)" :href="dingtalkLink(name)" class="staff-ding" :title="`钉钉联系${name}`" :aria-label="`钉钉联系${name}`">{{ name }}</a>
                <span v-else>{{ name }}</span>
              </template>
            </div>
          </div>
          <div ref="messageList" class="message-list" aria-live="polite">
            <div v-for="(message, index) in messages" :key="index" class="message" :class="[message.role, { welcome: message.welcome }]">
              <span class="message-avatar">{{ message.role === 'assistant' ? 'AI' : '我' }}</span>
              <div class="message-bubble" :class="{ streaming: message.pending }">
                <div v-if="message.role === 'assistant' && !message.welcome && (message.pending || message.done)" class="process-panel" :class="{ done: message.done }">
                  <div class="process-head">
                    <span class="process-mark" aria-hidden="true">✦</span>
                    <span class="process-title">{{ message.done ? title + '已为您生成答案' : '正在思考与检索知识…' }}</span>
                    <i v-if="message.pending" class="thought-live" aria-label="处理中" />
                  </div>
                </div>
                <div v-if="message.role === 'assistant' && message.thought" class="thought-panel" :class="{ open: message.thoughtOpen }">
                  <button type="button" class="thought-head" :aria-expanded="message.thoughtOpen" @click="message.thoughtOpen = !message.thoughtOpen">
                    <span class="thought-mark">✻</span>
                    <span>深度思考</span>
                    <i v-if="message.pending && message.thoughtOpen && !message.content" class="thought-live" aria-label="思考中" />
                    <span class="thought-chevron" aria-hidden="true">{{ message.thoughtOpen ? '︿' : '﹀' }}</span>
                  </button>
                  <div v-show="message.thoughtOpen" class="thought-body">{{ message.thought }}</div>
                </div>
                <div class="message-markdown" v-html="renderMessage(message.displayContent ?? message.content)" />
                <!-- 欢迎消息内嵌快捷操作：常用下载（弹下载弹窗）+ 常见问题（直接提问） -->
                <template v-if="message.welcome">
                  <div v-if="downloads.length" class="welcome-group">
                    <span class="welcome-label">常用下载</span>
                    <div class="welcome-actions">
                      <button v-for="item in downloads" :key="item.name" type="button" class="welcome-dl" :disabled="!item.url" :title="item.url ? `下载${item.name}` : '链接待配置'" @click="openDownload(item)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg>
                        <span>{{ item.name }}</span>
                      </button>
                    </div>
                  </div>
                  <div v-if="quickQuestions.length" class="welcome-group">
                    <span class="welcome-label">常见问题</span>
                    <div class="welcome-actions">
                      <button v-for="item in quickQuestions" :key="item.q" type="button" class="welcome-faq" @click="send(item.q)">{{ item.q }}</button>
                    </div>
                  </div>
                </template>
                <span v-if="message.pending && !message.displayContent && !message.thought" class="typing" aria-label="正在生成回复"><i></i><i></i><i></i></span>
                <span v-else-if="message.pending" class="stream-cursor" aria-hidden="true"></span>
              </div>
            </div>
          </div>
          <div class="composer">
            <textarea v-model="input" rows="3" placeholder="请输入你的问题…" aria-label="输入问题" @keydown.enter.exact.prevent="send()" />
            <div class="composer-footer"><span>Enter 发送 · Shift+Enter 换行</span><button type="button" :disabled="loading || !input.trim()" @click="send()">发送</button></div>
          </div>
        </main>
      </div>
    </section>

    <!-- 回答内图片放大预览：点遮罩关闭 -->
    <div v-if="imagePreview" class="image-preview" role="dialog" aria-label="图片预览" @click="imagePreview = ''">
      <img :src="imagePreview" alt="预览大图">
    </div>

    <!-- 下载弹窗：扫码下载 + 直接下载（内容受后台方式勾选控制），点遮罩或关闭按钮退出 -->
    <div v-if="dlPreview" class="dl-mask" role="dialog" aria-modal="true" :aria-label="`${dlPreview.name}下载`" @click="closeDownload">
      <div class="dl-dialog" @click.stop>
        <button type="button" class="dl-close" aria-label="关闭" @click="closeDownload">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <span class="dl-dialog-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg>
        </span>
        <h3>{{ dlPreview.name }}</h3>
        <p class="dl-dialog-sub">选择适合你的下载方式</p>
        <div v-if="dlQrImage" class="dl-dialog-qr">
          <img :src="dlQrImage" :alt="`${dlPreview.name}下载二维码`">
          <small>手机扫码下载 · 或用浏览器打开</small>
        </div>
        <a
          v-if="hasMethod(dlPreview, 'direct')"
          class="button primary dl-dialog-btn"
          :href="dlPreview.url"
          target="_blank"
          rel="noopener"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg>
          直接下载
        </a>
      </div>
    </div>
  </div>
</template>
