<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { formatDuty, parseDuty } from '../dutyText.mjs'

const sections = [
  ['brand', '机器人形象', '◉'],
  ['assistant', 'AI 助理', '✦'],
  ['duty', '值班表', '◷'],
  ['staff', '人员设置', '☺'],
  ['downloads', '下载汇总', '↓'],
  ['faq', '常见问题', '?'],
  ['embed', '嵌入接入', '</>'],
]
const active = ref('assistant')
const loading = ref(true)
const saving = ref(false)
const locked = ref(false)
const adminToken = ref(sessionStorage.getItem('zto_admin_token') || '')
const toast = ref('')
const settings = reactive({ mode: 'app', appId: '', model: '', systemPrompt: '', apiKey: '', hasApiKey: false })
const sidebar = reactive({ brand: { name: '', avatar: '' }, onDuty: { byDate: {}, byWeekday: {} }, downloads: [], faq: [], staff: [] })
const dutyText = ref('')

const current = computed(() => sections.find(item => item[0] === active.value))
const embedCode = computed(() => `<script src="${location.origin}/embed.js" data-position="right" data-bottom="24" data-side="24"><\/script>`)
const avatarIsImage = computed(() => /^(https?:|data:image)/i.test(sidebar.brand.avatar.trim()))
const avatarText = computed(() => sidebar.brand.avatar.trim() || 'AI')
const brandName = computed(() => sidebar.brand.name.trim() || '小冷')

function notice(message) {
  toast.value = message
  setTimeout(() => { if (toast.value === message) toast.value = '' }, 2400)
}
function headers(json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(adminToken.value ? { 'X-Admin-Token': adminToken.value } : {}),
  }
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) } })
  if (response.status === 401) { locked.value = true; throw new Error('管理令牌不正确') }
  let data
  try { data = await response.json() }
  catch { throw new Error(`服务响应异常（HTTP ${response.status}），请确认代理服务已启动`) }
  if (!response.ok || data.success === false) throw new Error(data.error || `请求失败（${response.status}）`)
  return data
}
function applySidebar(config = {}) {
  const duty = config.onDuty || {}
  sidebar.brand = { name: config.brand?.name || '', avatar: config.brand?.avatar || '' }
  sidebar.onDuty = { byDate: duty.byDate || {}, byWeekday: duty.byWeekday || {} }
  sidebar.downloads = Array.isArray(config.downloads) ? config.downloads.map(item => ({ name: item.name || '', url: item.url || '' })) : []
  sidebar.faq = Array.isArray(config.faq) ? config.faq.map(item => ({ q: item.q || '', a: item.a || '' })) : []
  sidebar.staff = Array.isArray(config.staff) ? config.staff.map(item => ({ name: item.name || '', dingtalkId: item.dingtalkId || '' })) : []
  dutyText.value = formatDuty(sidebar.onDuty)
}
async function load() {
  loading.value = true
  locked.value = false
  try {
    const side = await fetch('/api/sidebar').then(response => response.json())
    if (side.success) applySidebar(side.config)
    const data = await request('/api/admin/settings')
    Object.assign(settings, data.settings)
  } catch (error) {
    if (!locked.value) notice(error.message)
  } finally { loading.value = false }
}
function unlock() {
  sessionStorage.setItem('zto_admin_token', adminToken.value)
  load()
}
async function saveAi() {
  saving.value = true
  try {
    const data = await request('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ mode: settings.mode, appId: settings.appId, model: settings.model, systemPrompt: settings.systemPrompt, apiKey: settings.apiKey }),
    })
    Object.assign(settings, data.settings, { apiKey: '' })
    notice('AI 配置已保存')
  } catch (error) { notice(error.message) }
  finally { saving.value = false }
}
async function saveSidebar(message = '配置已保存') {
  saving.value = true
  sidebar.onDuty = parseDuty(dutyText.value)
  try {
    const data = await request('/api/sidebar', { method: 'POST', body: JSON.stringify({ config: sidebar }) })
    applySidebar(data.config)
    notice(message)
  } catch (error) { notice(error.message) }
  finally { saving.value = false }
}
function addDownload() { sidebar.downloads.push({ name: '', url: '' }) }
function addFaq() { sidebar.faq.push({ q: '', a: '' }) }
function addStaff() { sidebar.staff.push({ name: '', dingtalkId: '' }) }
async function copyEmbed() {
  await navigator.clipboard.writeText(embedCode.value)
  notice('嵌入代码已复制')
}

onMounted(load)
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <div class="admin-brand"><span>AI</span><div><b>小冷管理后台</b><small>Cold Chain Assistant</small></div></div>
      <nav>
        <button v-for="item in sections" :key="item[0]" type="button" :class="{ active: active === item[0] }" @click="active = item[0]">
          <i>{{ item[2] }}</i><span>{{ item[1] }}</span>
        </button>
      </nav>
      <div class="admin-sidebar-footer"><span :class="{ ok: settings.hasApiKey }" />{{ settings.hasApiKey ? 'AI 服务已配置' : 'AI 服务待配置' }}</div>
    </aside>

    <main class="admin-main">
      <header class="admin-header"><div><span class="breadcrumb">管理后台 / {{ current?.[1] }}</span><h1>{{ current?.[1] }}</h1></div><span class="version">Node.js + Vue</span></header>

      <div v-if="loading" class="admin-loading">正在读取配置…</div>
      <section v-else-if="locked" class="auth-card card">
        <span class="card-icon">⌁</span><h2>输入管理令牌</h2><p>服务端已设置 <code>ADMIN_TOKEN</code>，请输入令牌后继续。</p>
        <input v-model="adminToken" type="password" autocomplete="current-password" placeholder="管理令牌" @keydown.enter="unlock">
        <button class="button primary" type="button" @click="unlock">进入后台</button>
      </section>

      <div v-else class="admin-content">
        <div class="security-note"><b>内网管理页</b><span>生产环境请设置 <code>ADMIN_TOKEN</code>，根页面不会展示后台入口。</span></div>

        <section v-if="active === 'brand'" class="card">
          <div class="card-head"><div><h2>机器人形象</h2><p>自定义聊天窗口中机器人的名称与头像。留空时使用默认值（小冷 / AI）。嵌入方若显式设置了 <code>data-title</code>，仍以嵌入方为准。</p></div><span class="status-badge success">实时预览</span></div>
          <div class="form-grid">
            <label><span>机器人名称</span><input v-model="sidebar.brand.name" placeholder="例如：小冷" maxlength="30"></label>
            <label><span>头像（图片 URL 或文字/表情）</span><input v-model="sidebar.brand.avatar" placeholder="https://…/logo.png 或 🐧、小冷"></label>
          </div>
          <div class="brand-preview">
            <span class="brand-preview-avatar"><img v-if="avatarIsImage" :src="sidebar.brand.avatar.trim()" alt="头像预览">{{ avatarIsImage ? '' : avatarText }}</span>
            <div><b>{{ brandName }}</b><small>服务正常</small></div>
          </div>
          <div class="card-actions"><button class="button primary" type="button" :disabled="saving" @click="saveSidebar()">保存形象设置</button></div>
        </section>

        <section v-if="active === 'assistant'" class="card">
          <div class="card-head"><div><h2>模型接入</h2><p>API Key 仅保存在 Node.js 服务端，不会返回到浏览器。</p></div><span class="status-badge" :class="{ success: settings.hasApiKey }">{{ settings.hasApiKey ? '已配置 Key' : '未配置 Key' }}</span></div>
          <div class="segmented"><button type="button" :class="{ active: settings.mode === 'app' }" @click="settings.mode = 'app'">百炼智能体</button><button type="button" :class="{ active: settings.mode === 'model' }" @click="settings.mode = 'model'">模型直调</button></div>
          <div class="form-grid">
            <label v-if="settings.mode === 'app'"><span>应用 ID</span><input v-model="settings.appId" placeholder="百炼应用 App ID"></label>
            <label v-else><span>模型名称</span><input v-model="settings.model" placeholder="例如 qwen-plus"></label>
            <label><span>API Key</span><input v-model="settings.apiKey" type="password" autocomplete="new-password" :placeholder="settings.hasApiKey ? '已配置，留空保持不变' : 'sk-…'"></label>
            <label class="full"><span>系统提示词</span><textarea v-model="settings.systemPrompt" rows="8" placeholder="定义助理的人设、边界和回复要求"></textarea></label>
          </div>
          <div class="card-actions"><button class="button primary" type="button" :disabled="saving" @click="saveAi">{{ saving ? '保存中…' : '保存 AI 配置' }}</button></div>
        </section>

        <section v-if="active === 'duty'" class="card">
          <div class="card-head"><div><h2>技术支持值班表</h2><p>直接使用文本配置；支持按星期或精确日期，精确日期优先。</p></div></div>
          <label class="field"><span>排班内容</span><textarea v-model="dutyText" rows="15" placeholder="周一：李勇,乔羽&#10;2026-09-02：李勇,乔羽,韩刚"></textarea><small>格式：日期或星期 + 中文冒号 + 姓名，多个姓名用逗号分隔。</small></label>
          <div class="card-actions"><button class="button primary" type="button" :disabled="saving" @click="saveSidebar()">保存值班表</button></div>
        </section>

        <section v-if="active === 'staff'" class="card">
          <div class="card-head"><div><h2>人员设置</h2><p>为值班人员填写钉钉号后，聊天窗口中该人员姓名可点击，直接唤起钉钉发起单聊。钉钉号可在钉钉客户端「我的 → 我的信息」中查看。</p></div><button class="button secondary" type="button" @click="addStaff">添加人员</button></div>
          <div class="editable-list"><div v-for="(item, index) in sidebar.staff" :key="index" class="editable-row"><input v-model="item.name" placeholder="姓名（需与值班表一致）"><input v-model="item.dingtalkId" placeholder="钉钉号，例如 zhangsan001"><button type="button" aria-label="删除" @click="sidebar.staff.splice(index, 1)">×</button></div><p v-if="!sidebar.staff.length" class="empty">暂无人员，点击右上角「添加人员」</p></div>
          <div class="card-actions"><button class="button primary" type="button" :disabled="saving" @click="saveSidebar()">保存人员设置</button></div>
        </section>

        <section v-if="active === 'downloads'" class="card">
          <div class="card-head"><div><h2>下载汇总</h2><p>为聊天窗口配置常用客户端或资料下载地址。</p></div><button class="button secondary" type="button" @click="addDownload">添加下载项</button></div>
          <div class="editable-list"><div v-for="(item, index) in sidebar.downloads" :key="index" class="editable-row"><input v-model="item.name" placeholder="显示名称"><input v-model="item.url" placeholder="https://…"><button type="button" aria-label="删除" @click="sidebar.downloads.splice(index, 1)">×</button></div><p v-if="!sidebar.downloads.length" class="empty">暂无下载项</p></div>
          <div class="card-actions"><button class="button primary" type="button" :disabled="saving" @click="saveSidebar()">保存下载项</button></div>
        </section>

        <section v-if="active === 'faq'" class="card">
          <div class="card-head"><div><h2>常见问题</h2><p>配置聊天窗口内的快捷提问，答案留空时由 AI 生成。</p></div><button class="button secondary" type="button" @click="addFaq">添加问题</button></div>
          <div class="faq-editor"><div v-for="(item, index) in sidebar.faq" :key="index" class="faq-row"><div><label><span>问题</span><input v-model="item.q" placeholder="请输入问题"></label><label><span>固定答案（可选）</span><textarea v-model="item.a" rows="3" placeholder="留空则调用 AI"></textarea></label></div><button type="button" aria-label="删除" @click="sidebar.faq.splice(index, 1)">×</button></div><p v-if="!sidebar.faq.length" class="empty">暂无常见问题</p></div>
          <div class="card-actions"><button class="button primary" type="button" :disabled="saving" @click="saveSidebar()">保存常见问题</button></div>
        </section>

        <section v-if="active === 'embed'" class="card">
          <div class="card-head"><div><h2>第三方系统嵌入</h2><p>在第三方页面的 <code>&lt;/body&gt;</code> 前插入一段脚本，即可显示右下角 AI 气泡。</p></div><span class="status-badge success">iframe 隔离</span></div>
          <label class="field"><span>嵌入代码</span><textarea :value="embedCode" rows="5" readonly></textarea></label>
          <div class="card-actions between"><span>完整说明见 <code>docs/EMBEDDING.md</code></span><button class="button primary" type="button" @click="copyEmbed">复制代码</button></div>
        </section>
      </div>
    </main>
    <div v-if="toast" class="admin-toast">{{ toast }}</div>
  </div>
</template>
