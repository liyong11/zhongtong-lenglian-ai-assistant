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

// 机器人形象：名称与头像（头像为图片 URL 时渲染图片，否则渲染文字/表情）
const title = computed(() => urlTitle || sidebar.value.brand?.name || '小冷')
const avatar = computed(() => String(sidebar.value.brand?.avatar || '').trim())
const avatarIsImage = computed(() => /^(https?:|data:image)/i.test(avatar.value))
const avatarText = computed(() => avatar.value || 'AI')

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
  if (embedded) window.parent.postMessage({ source: 'zto-ai-widget', type: 'resize', state }, parentOrigin)
}
function openChat() {
  open.value = true
  if (!messages.value.length) messages.value.push({ role: 'assistant', content: `你好，我是${title.value}。可以问我订单查询、异常处理和操作指引。` })
  notify(maximized.value ? 'maximized' : 'open')
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
  messages.value = [{ role: 'assistant', content: `你好，我是${title.value}。新的对话已开始。` }]
  sessionId.value = null
}
async function scrollToBottom() {
  await nextTick()
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight
}
function startAnswerAnimation(answer) {
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
    answer.animationId = requestAnimationFrame(tick)
  }
  answer.animationId = requestAnimationFrame(tick)
}
function chunkText(data) {
  if (typeof data?.text === 'string') return data.text
  if (typeof data?.content === 'string') return data.content
  return ''
}
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
        answer.content += chunkText(data)
        if (data.session_id) sessionId.value = data.session_id
        if (answer.thoughtOpen) answer.thoughtOpen = false
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
  notify('collapsed')
  try {
    const [ping, config] = await Promise.all([fetch('/api/ping'), fetch('/api/sidebar')])
    online.value = (await ping.json()).configured === true
    const data = await config.json()
    if (data.success) sidebar.value = data.config || sidebar.value
  } catch { online.value = false }
})
onUnmounted(() => clearInterval(clockTimer))
</script>

<template>
  <div class="widget-root" :class="{ embedded, maximized }">
    <button v-if="!open" class="launcher" type="button" aria-label="打开智能助理" @click="openChat">
      <span class="launcher-mark"><img v-if="avatarIsImage" :src="avatar" alt=""><template v-else>{{ avatarText }}</template></span>
      <span class="launcher-pulse" />
    </button>

    <section v-else class="chat-window" :class="{ maximized }" aria-label="智能助理对话窗口">
      <header class="chat-header">
        <div class="bot-identity">
          <span class="bot-avatar"><img v-if="avatarIsImage" :src="avatar" alt=""><template v-else>{{ avatarText }}</template></span>
          <span><b>{{ title }}</b><small><i :class="{ online }" />{{ online ? '服务正常' : '服务未配置' }}</small></span>
        </div>
        <div class="window-actions">
          <button type="button" title="新对话" aria-label="新对话" @click="resetChat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
          <button type="button" title="最小化" aria-label="最小化" @click="minimize">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button type="button" :title="maximized ? '还原' : '最大化'" :aria-label="maximized ? '还原' : '最大化'" @click="toggleMaximize">
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
          <div class="aside-card">
            <span class="eyebrow">今日技术支持</span>
            <strong>{{ today.weekday }} · {{ today.date }}</strong>
            <div v-if="today.staff.length" class="staff-list">
              <template v-for="name in today.staff" :key="name">
                <a v-if="dingtalkLink(name)" :href="dingtalkLink(name)" class="staff-ding" :title="`钉钉联系${name}`" :aria-label="`钉钉联系${name}`" @click.stop>{{ name }}</a>
                <span v-else>{{ name }}</span>
              </template>
            </div>
            <p v-else>今日暂无值班安排</p>
            <small v-if="today.staff.some(name => dingtalkLink(name))" class="staff-tip">点击姓名可发起钉钉单聊</small>
          </div>
          <div class="aside-card grow">
            <span class="eyebrow">常见问题</span>
            <button v-for="item in quickQuestions" :key="item.q" type="button" class="quick-link" @click="send(item.q)">{{ item.q }}<span>›</span></button>
          </div>
        </aside>

        <main class="conversation">
          <div v-if="today.staff.length" class="mobile-duty">
            <span class="mobile-duty-label">今日值班</span>
            <div class="mobile-duty-staff">
              <template v-for="name in today.staff" :key="name">
                <a v-if="dingtalkLink(name)" :href="dingtalkLink(name)" class="staff-ding" :title="`钉钉联系${name}`" :aria-label="`钉钉联系${name}`">{{ name }}</a>
                <span v-else>{{ name }}</span>
              </template>
            </div>
          </div>
          <div ref="messageList" class="message-list" aria-live="polite">
            <div v-for="(message, index) in messages" :key="index" class="message" :class="message.role">
              <span class="message-avatar">{{ message.role === 'assistant' ? 'AI' : '我' }}</span>
              <div class="message-bubble" :class="{ streaming: message.pending }">
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
                <span v-if="message.pending && !message.displayContent && !message.thought" class="typing" aria-label="正在生成回复"><i></i><i></i><i></i></span>
                <span v-else-if="message.pending" class="stream-cursor" aria-hidden="true"></span>
              </div>
            </div>
          </div>
          <div class="composer">
            <textarea v-model="input" rows="4" placeholder="请输入你的问题…" aria-label="输入问题" @keydown.enter.exact.prevent="send()" />
            <div class="composer-footer"><span>Enter 发送 · Shift+Enter 换行</span><button type="button" :disabled="loading || !input.trim()" @click="send()">发送</button></div>
          </div>
        </main>
      </div>
    </section>
  </div>
</template>
