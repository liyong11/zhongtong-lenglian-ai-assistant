<script setup>
import { onMounted, ref } from 'vue'

// 独立登录页：管理后台未登录时跳转到这里（对标 houpe-auth 的 /auth/login）
const query = new URLSearchParams(location.search)
const redirect = (query.get('redirect') || '/admin').startsWith('/') && query.get('redirect') !== '/login' ? query.get('redirect') : '/admin'
const error = ref(query.get('error') || '')
const busy = ref(false)
const checking = ref(true)
const corpId = ref('')
const dingtalkReady = ref(false)
const autoTried = ref(false)
const isInDingTalk = navigator.userAgent.toLowerCase().includes('dingtalk')

function gotoDingtalk() {
  busy.value = true
  error.value = ''
  fetch('/api/auth/dingtalk/url?redirect=' + encodeURIComponent(redirect))
    .then(response => response.json())
    .then(data => {
      if (data.url) window.location.href = data.url
      else { error.value = data.error || '获取登录地址失败'; busy.value = false }
    })
    .catch(err => { error.value = err.message; busy.value = false })
}

function autoLogin() {
  busy.value = true
  const script = document.createElement('script')
  script.src = 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js'
  script.onload = () => {
    window.dd.ready(() => {
      window.dd.runtime.permission.requestAuthCode({
        corpId: corpId.value,
        onSuccess: async result => {
          try {
            const data = await fetch('/api/auth/dingtalk/auto', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ authCode: result.code }),
            }).then(response => response.json())
            if (data.success) window.location.replace(redirect)
            else { error.value = data.error || '钉钉免登失败'; busy.value = false }
          } catch (err) { error.value = err.message; busy.value = false }
        },
        onFail: () => { error.value = '钉钉免登失败，请点击按钮扫码登录'; busy.value = false },
      })
    })
  }
  script.onerror = () => { error.value = '钉钉 SDK 加载失败，请点击按钮扫码登录'; busy.value = false }
  document.head.appendChild(script)
}

onMounted(async () => {
  try {
    const data = await fetch('/api/auth/me').then(response => response.json())
    dingtalkReady.value = Boolean(data.dingtalkConfigured)
    corpId.value = data.corpId || ''
    // 已登录（会话还在）直接进目标页
    if (data.loggedIn) { window.location.replace(redirect); return }
  } catch { /* 服务未起时仍展示页面与错误提示 */ }
  checking.value = false
  // 钉钉客户端内打开时自动免登，无需扫码
  if (isInDingTalk && corpId.value) { autoTried.value = true; autoLogin() }
})
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo"><span>AI</span></div>
      <h1>中通冷链 AI 助理</h1>
      <p class="login-sub">管理后台 · 钉钉身份验证</p>

      <p v-if="checking" class="login-status">正在检查登录状态…</p>
      <template v-else>
        <button v-if="dingtalkReady" class="login-ding-btn" type="button" :disabled="busy" @click="gotoDingtalk">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.02-1.96 1.25-5.54 3.69-.52.36-1 .53-1.42.52-.47-.01-1.37-.26-2.03-.48-.82-.27-1.47-.42-1.42-.88.03-.24.37-.49 1.02-.75 3.99-1.74 6.65-2.89 7.99-3.44 3.8-1.58 4.59-1.86 5.1-1.87.11 0 .37.03.54.17.14.12.18.28.2.45-.01.06.01.24 0 .38z"/></svg>
          {{ busy ? '正在连接钉钉…' : '使用钉钉登录' }}
        </button>
        <p v-else class="login-status error">服务端未配置钉钉登录，请联系管理员填写 dingtalkAppKey / dingtalkAppSecret</p>

        <p v-if="error" class="login-error" role="alert">{{ error }}</p>
        <p v-if="autoTried && !error" class="login-hint">检测到钉钉环境，正在自动登录…</p>
      </template>

      <div class="login-footer">仅限「人员设置」中勾选管理员的钉钉账号登录</div>
    </div>
  </div>
</template>
