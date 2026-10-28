<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { formatDuty, parseDuty } from '../dutyText.mjs'

const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const sections = [
  ['brand', '机器人形象', svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.8-5.5 8-5.5s6.5 1.5 8 5.5"/>')],
  ['assistant', 'AI 助理', svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>')],
  ['duty', '值班表', svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')],
  ['staff', '人员设置', svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3.2 3.8-4.5 6.5-4.5s5.3 1.3 6.5 4.5"/><circle cx="17" cy="9" r="2.8"/><path d="M17.5 15.6c2.2.4 3.6 1.7 4.3 3.9"/>')],
  ['downloads', '下载汇总', svg('<path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>')],
  ['faq', '常见问题', svg('<circle cx="12" cy="12" r="9"/><path d="M9.4 9a2.6 2.6 0 1 1 3.9 2.3c-.8.5-1.3 1-1.3 1.9"/><path d="M12 17h.01"/>')],
  ['embed', '嵌入接入', svg('<path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/>')],
]
const active = ref('assistant')
const loading = ref(true)
const saving = ref(false)
const locked = ref(false)
const me = ref(null)
const dingtalkReady = ref(false)
const adminToken = ref(sessionStorage.getItem('zto_admin_token') || '')
const toast = ref('')
const settings = reactive({ mode: 'app', appId: '', model: '', systemPrompt: '', apiKey: '', hasApiKey: false, allowedDomains: '', embedToken: '' })
const sidebar = reactive({ brand: { name: '', avatar: '', launcher: '' }, onDuty: { byDate: {}, byWeekday: {} }, downloads: [], faq: [], staff: [] })
const dutyText = ref('')
const uploadTarget = ref('')
const uploading = ref('')
const fileInput = ref(null)

const current = computed(() => sections.find(item => item[0] === active.value))
// 配了嵌入口令时，悬浮代码自动带 ?token=；口令或白名单任一道拦住即无法嵌入
const embedQuery = computed(() => settings.embedToken ? `?token=${encodeURIComponent(settings.embedToken)}` : '')
const embedCode = computed(() => `<script src="${location.origin}/embed.js${embedQuery.value}" data-position="right" data-bottom="24" data-side="24"><\/script>`)
const embedFull = computed(() => `<iframe src="${location.origin}/?mode=full" style="width:100%;height:100%;min-height:560px;border:0" allow="microphone"></iframe>`)
const avatarIsImage = computed(() => /^(https?:|data:image|\/(?:uploads|presets)\/)/i.test(sidebar.brand.avatar.trim()))
const avatarText = computed(() => sidebar.brand.avatar.trim() || 'AI')
const launcherIsImage = computed(() => /^(https?:|data:image|\/(?:uploads|presets)\/)/i.test(sidebar.brand.launcher.trim()))
const launcherText = computed(() => sidebar.brand.launcher.trim() || avatarText.value)
const brandName = computed(() => sidebar.brand.name.trim() || '小冷')

// 预设形象：点选填充头像与悬浮按钮图（-half/-blink 眨眼帧按同名约定自动配套），保存后生效
const brandPresets = [
  { id: 'teal', name: '冷链青', launcher: '/presets/teal.png', avatar: '/presets/teal.png' },
  { id: 'blue', name: '经典蓝', launcher: '/presets/blue.png', avatar: '/presets/blue.png' },
]
function applyPreset(p) {
  sidebar.brand.launcher = p.launcher
  sidebar.brand.avatar = p.avatar
}

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
  if (response.status === 401) {
    // 已配置钉钉登录时跳独立登录页，否则回落到管理令牌输入
    if (dingtalkReady.value && !me.value) window.location.href = '/login?redirect=/admin'
    else locked.value = true
    throw new Error('需要登录管理后台')
  }
  let data
  try { data = await response.json() }
  catch { throw new Error(`服务响应异常（HTTP ${response.status}），请确认代理服务已启动`) }
  if (!response.ok || data.success === false) throw new Error(data.error || `请求失败（${response.status}）`)
  return data
}

// ---------- 登录态探测（钉钉登录对接 houpe-auth 同款流程，登录页在 /login） ----------
async function checkAuth() {
  try {
    const data = await fetch('/api/auth/me').then(response => response.json())
    dingtalkReady.value = Boolean(data.dingtalkConfigured)
    if (data.loggedIn && data.user) { me.value = data.user; return true }
  } catch { /* 服务未起时按未登录处理 */ }
  return false
}
async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }) } catch { /* 忽略网络错误，本地照常登出 */ }
  sessionStorage.removeItem('zto_admin_token')
  window.location.href = '/login?redirect=/admin'
}
function applySidebar(config = {}) {
  const duty = config.onDuty || {}
  sidebar.brand = { name: config.brand?.name || '', avatar: config.brand?.avatar || '', launcher: config.brand?.launcher || '' }
  sidebar.onDuty = { byDate: duty.byDate || {}, byWeekday: duty.byWeekday || {} }
  sidebar.downloads = Array.isArray(config.downloads) ? config.downloads.map(item => ({ name: item.name || '', url: item.url || '', methods: Array.isArray(item.methods) ? item.methods : ['qr', 'direct'] })) : []
  sidebar.faq = Array.isArray(config.faq) ? config.faq.map(item => ({ q: item.q || '', a: item.a || '' })) : []
  sidebar.staff = Array.isArray(config.staff) ? config.staff.map(item => ({ name: item.name || '', dingtalkId: item.dingtalkId || '', isAdmin: Boolean(item.isAdmin), userId: item.userId || '' })) : []
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
async function saveEmbed() {
  saving.value = true
  try {
    const data = await request('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ mode: settings.mode, appId: settings.appId, model: settings.model, systemPrompt: settings.systemPrompt, allowedDomains: settings.allowedDomains, embedToken: settings.embedToken }),
    })
    Object.assign(settings, data.settings, { apiKey: '' })
    notice('嵌入配置已保存')
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
function addDownload() { sidebar.downloads.push({ name: '', url: '', methods: ['qr', 'direct'] }) }
function toggleDownloadMethod(item, method) {
  const set = new Set(item.methods)
  if (set.has(method)) set.delete(method)
  else set.add(method)
  item.methods = Array.from(set)
}
// ---------- 图片上传（机器人头像 / 悬浮按钮图）：请求体为原始图片字节，服务端落盘后返回 /uploads/ 地址 ----------
function pickImage(field) {
  uploadTarget.value = field
  if (fileInput.value) { fileInput.value.value = ''; fileInput.value.click() }
}
async function uploadImage(event) {
  const file = event.target.files && event.target.files[0]
  const field = uploadTarget.value
  if (!file || !field) return
  if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) { notice('仅支持 PNG / JPG / GIF / WebP 图片'); return }
  if (file.size > 2 * 1024 * 1024) { notice('图片不能超过 2MB'); return }
  uploading.value = field
  try {
    const data = await request('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: await file.arrayBuffer() })
    sidebar.brand[field] = data.url
    notice('图片已上传，点击保存后生效')
  } catch (error) { notice(error.message) }
  finally { uploading.value = '' }
}
function addFaq() { sidebar.faq.push({ q: '', a: '' }) }
function addStaff() { sidebar.staff.push({ name: '', dingtalkId: '', isAdmin: false, userId: '' }) }
async function copyEmbed(code = embedCode.value, message = '嵌入代码已复制') {
  await navigator.clipboard.writeText(code)
  notice(message)
}

onMounted(async () => {
  const loggedIn = await checkAuth()
  if (loggedIn) { load(); return }
  if (dingtalkReady.value) {
    // 独立登录页承担扫码/免登/错误展示
    window.location.href = '/login?redirect=/admin'
    return
  }
  load()
})
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <div class="admin-brand"><span>AI</span><div><b>小冷管理后台</b><small>Cold Chain Assistant</small></div></div>
      <nav>
        <button v-for="item in sections" :key="item[0]" type="button" :class="{ active: active === item[0] }" @click="active = item[0]">
          <i v-html="item[2]" /><span>{{ item[1] }}</span>
        </button>
      </nav>
      <div class="admin-sidebar-footer">
        <div class="footer-status"><span :class="{ ok: settings.hasApiKey }" />{{ settings.hasApiKey ? 'AI 服务已配置' : 'AI 服务待配置' }}</div>
        <div v-if="me" class="footer-user">
          <span class="footer-avatar"><img v-if="me.avatar" :src="me.avatar" alt=""><template v-else>{{ me.name.slice(0, 1) }}</template></span>
          <span class="footer-name">{{ me.name }}</span>
          <button class="footer-logout" type="button" @click="logout">退出</button>
        </div>
      </div>
    </aside>

    <main class="admin-main">
      <header class="admin-header"><div><span class="breadcrumb">管理后台 / {{ current?.[1] }}</span><h1>{{ current?.[1] }}</h1></div></header>

      <div v-if="loading" class="admin-loading">正在读取配置…</div>
      <section v-else-if="locked" class="auth-card card">
        <span class="card-icon">⌁</span><h2>输入管理令牌</h2><p>服务端已设置 <code>ADMIN_TOKEN</code>，请输入令牌后继续。</p>
        <input v-model="adminToken" type="password" autocomplete="current-password" placeholder="管理令牌" @keydown.enter="unlock">
        <button class="button primary" type="button" @click="unlock">进入后台</button>
      </section>

      <div v-else class="admin-content">
        <div class="security-note"><b>内网管理页</b><span>生产环境请设置 <code>ADMIN_TOKEN</code>，根页面不会展示后台入口。</span></div>

        <section v-if="active === 'brand'" class="card">
          <div class="card-head"><div><h2>机器人形象</h2><p>自定义聊天窗口中机器人的名称、头像与悬浮按钮图片。留空时使用默认值（小冷 / AI）；悬浮按钮图片留空时沿用机器人头像。嵌入方若显式设置了 <code>data-title</code>，仍以嵌入方为准。</p></div><span class="status-badge success">实时预览</span></div>
          <div class="preset-section">
            <span class="preset-label">预设形象（点选填充，再点下方「保存形象设置」生效；也可继续自定义上传）</span>
            <div class="preset-list">
              <button v-for="p in brandPresets" :key="p.id" type="button" class="preset-card" :class="{ active: sidebar.brand.launcher === p.launcher }" @click="applyPreset(p)">
                <img :src="p.launcher" :alt="p.name">
                <span>{{ p.name }}</span>
              </button>
            </div>
          </div>
          <div class="form-grid">
            <label><span>机器人名称</span><input v-model="sidebar.brand.name" placeholder="例如：小冷" maxlength="30"></label>
            <div class="image-field">
              <span>机器人头像（上传 / 图片 URL / 文字表情）</span>
              <div class="image-field-row">
                <input v-model="sidebar.brand.avatar" placeholder="https://…/logo.png 或 🐧、小冷">
                <button class="upload-btn" type="button" :disabled="!!uploading" @click="pickImage('avatar')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>
                  {{ uploading === 'avatar' ? '上传中…' : '上传图片' }}
                </button>
              </div>
            </div>
            <div class="image-field">
              <span>悬浮按钮图片（上传 / 图片 URL / 文字表情）</span>
              <div class="image-field-row">
                <input v-model="sidebar.brand.launcher" placeholder="留空沿用机器人头像">
                <button class="upload-btn" type="button" :disabled="!!uploading" @click="pickImage('launcher')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>
                  {{ uploading === 'launcher' ? '上传中…' : '上传图片' }}
                </button>
              </div>
            </div>
          </div>
          <input ref="fileInput" class="file-input-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" @change="uploadImage">
          <div class="brand-preview">
            <span class="brand-preview-avatar brand-preview-launcher" :title="launcherIsImage ? '悬浮按钮' : ''"><img v-if="launcherIsImage" :src="sidebar.brand.launcher.trim()" alt="悬浮按钮预览">{{ launcherIsImage ? '' : launcherText }}</span>
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
          <div class="card-head"><div><h2>人员设置</h2><p>为值班人员填写钉钉号后，聊天窗口中该人员姓名可点击，直接唤起钉钉发起单聊。勾选「管理员」的人员才能用钉钉登录管理后台（按登录时自动记录的 userId / 钉钉号 / 姓名匹配）；未勾选管理员期间全员可登录，便于首次配置。</p></div><button class="button secondary" type="button" @click="addStaff">添加人员</button></div>
          <div class="editable-list">
            <div v-for="(item, index) in sidebar.staff" :key="index" class="editable-row staff-row">
              <input v-model="item.name" placeholder="姓名（需与值班表一致）">
              <input v-model="item.dingtalkId" placeholder="钉钉号，例如 zhangsan001">
              <label class="admin-switch" :title="`允许${item.name || '该人员'}登录管理后台`">
                <input v-model="item.isAdmin" type="checkbox">
                <i class="track" aria-hidden="true"></i>
                <span>管理员</span>
              </label>
              <button type="button" aria-label="删除" @click="sidebar.staff.splice(index, 1)">×</button>
            </div>
            <p v-if="!sidebar.staff.length" class="empty">暂无人员，点击右上角「添加人员」</p>
          </div>
          <div class="card-actions"><button class="button primary" type="button" :disabled="saving" @click="saveSidebar()">保存人员设置</button></div>
        </section>

        <section v-if="active === 'downloads'" class="card">
          <div class="card-head"><div><h2>下载汇总</h2><p>为聊天窗口配置常用客户端或资料下载地址。每个下载项可勾选展示方式：二维码（手机扫码）和/或直接下载，都不勾选则聊天窗口中不显示该条目的操作按钮。</p></div><button class="button secondary" type="button" @click="addDownload">添加下载项</button></div>
          <div class="editable-list"><div v-for="(item, index) in sidebar.downloads" :key="index" class="editable-row dl-row"><input v-model="item.name" placeholder="显示名称"><input v-model="item.url" placeholder="https://…"><span class="dl-methods"><label class="dl-method" title="展示扫码下载入口"><input type="checkbox" :checked="item.methods.includes('qr')" @change="toggleDownloadMethod(item, 'qr')"><i>二维码</i></label><label class="dl-method" title="展示直接下载入口"><input type="checkbox" :checked="item.methods.includes('direct')" @change="toggleDownloadMethod(item, 'direct')"><i>直接下载</i></label></span><button type="button" aria-label="删除" @click="sidebar.downloads.splice(index, 1)">×</button></div><p v-if="!sidebar.downloads.length" class="empty">暂无下载项</p></div>
          <div class="card-actions"><button class="button primary" type="button" :disabled="saving" @click="saveSidebar()">保存下载项</button></div>
        </section>

        <section v-if="active === 'faq'" class="card">
          <div class="card-head"><div><h2>常见问题</h2><p>配置聊天窗口内的快捷提问，答案留空时由 AI 生成。</p></div><button class="button secondary" type="button" @click="addFaq">添加问题</button></div>
          <div class="faq-editor"><div v-for="(item, index) in sidebar.faq" :key="index" class="faq-row"><div><label><span>问题</span><input v-model="item.q" placeholder="请输入问题"></label><label><span>固定答案（可选）</span><textarea v-model="item.a" rows="3" placeholder="留空则调用 AI"></textarea></label></div><button type="button" aria-label="删除" @click="sidebar.faq.splice(index, 1)">×</button></div><p v-if="!sidebar.faq.length" class="empty">暂无常见问题</p></div>
          <div class="card-actions"><button class="button primary" type="button" :disabled="saving" @click="saveSidebar()">保存常见问题</button></div>
        </section>

        <section v-if="active === 'embed'" class="card">
          <div class="card-head"><div><h2>第三方系统嵌入</h2><p>复制对应代码到第三方页面即可。两种方式都会以 iframe 加载本系统，因此下方「允许嵌入的域名」白名单对两者同时生效。</p></div><span class="status-badge success">iframe 隔离</span></div>
          <div class="embed-modes">
            <div class="embed-mode">
              <b>悬浮气泡（推荐）</b>
              <p>在第三方页面右下角显示 AI 悬浮按钮，点击弹出对话窗口。可加 <code>data-title</code> / <code>data-position</code> / <code>data-bottom</code> / <code>data-side</code> 调整。</p>
              <textarea :value="embedCode" rows="4" readonly></textarea>
              <button class="button secondary" type="button" @click="copyEmbed(embedCode, '悬浮代码已复制')">复制代码</button>
            </div>
            <div class="embed-mode">
              <b>全屏 / 移动端整页</b>
              <p>以 iframe 铺满容器，适合门户整页、大屏或手机端。挂件会自动展开为全屏对话窗。</p>
              <textarea :value="embedFull" rows="4" readonly></textarea>
              <button class="button secondary" type="button" @click="copyEmbed(embedFull, '全屏代码已复制')">复制代码</button>
            </div>
          </div>
          <div class="form-grid">
            <label><span>嵌入口令（自定义字符串，可选）</span><input v-model="settings.embedToken" placeholder="留空 = 任何网站都可加载气泡脚本" maxlength="100"></label>
            <label><span>允许嵌入的域名（防盗链白名单，可选）</span><textarea v-model="settings.allowedDomains" rows="3" placeholder="例如：&#10;example.com&#10;*.oa.example.com"></textarea><small>两道防线相互独立：口令管「谁能加载气泡脚本」，白名单管「谁的页面能把对话窗嵌进 iframe」。都留空 = 完全开放。</small></label>
          </div>
          <div class="card-actions between"><span>白名单每行一个（逗号/空格分隔亦可），自动忽略协议和路径，<code>*.</code> 匹配子域名，由浏览器 <code>frame-ancestors</code> 强制执行。完整说明见 <code>docs/EMBEDDING.md</code></span><button class="button primary" type="button" :disabled="saving" @click="saveEmbed">保存嵌入配置</button></div>
        </section>
      </div>
    </main>
    <div v-if="toast" class="admin-toast" role="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      {{ toast }}
    </div>
  </div>
</template>
