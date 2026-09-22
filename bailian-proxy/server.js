/**
 * 中通冷链 AI 智能助理 —— 百炼模型代理服务器
 *
 * 作用：
 *  1. 解决浏览器 CORS 限制（浏览器不允许直接请求 dashscope.aliyuncs.com）
 *  2. 保护 API Key（Key 只存在本文件同目录的 config.json，绝不下发到前端）
 *  3. 静态托管 Vue 构建产物，提供气泡组件、管理后台与嵌入脚本
 *
 * 用法：
 *  node server.js          （端口默认 8787，可用环境变量 PORT 覆盖）
 *  然后浏览器打开 http://localhost:8787/
 *
 * 支持两种百炼接入模式（config.json 二选一填写）：
 *  A. 智能体应用（推荐）：填 appId —— 走 /api/v1/apps/{appId}/completion
 *     百炼控制台上配置了人设/知识库的应用，支持 session_id 云端多轮记忆
 *  B. 模型直调：填 model（如 qwen-plus）—— 走 OpenAI 兼容接口
 *     由代理层拼 system 提示词维护人设，多轮历史由前端传入
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dingtalk = require('./dingtalk');

const DIST_ROOT = path.resolve(__dirname, '../dist');
const PORT = process.env.PORT || 8787;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CFG_PATH = path.join(__dirname, 'config.json');
const SIDEBAR_PATH = path.join(__dirname, 'sidebar.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 后台可上传的图片类型：扩展名即落盘扩展名（不收 svg，避免脚本注入）
const UPLOAD_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
};
const UPLOAD_NAME_RE = /^[a-z0-9-]+\.(png|jpg|gif|webp)$/;
const SESSIONS_PATH = path.join(__dirname, 'sessions.json');
const SESSION_COOKIE = 'zto_admin_sess';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

// JSON 配置读写：损坏时备份并回退空配置；写入走临时文件 + rename，避免写入中途崩溃留下截断 JSON
function loadJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const backup = filePath + '.corrupt-' + Date.now();
      try {
        fs.renameSync(filePath, backup);
        console.error('[' + label + '] 配置解析失败，已把损坏文件备份为 ' + backup + '，本次按空配置处理');
      } catch (e2) {
        console.error('[' + label + '] 配置解析失败且备份失败：' + (e2.message || e2));
      }
    }
    return {};
  }
}
function writeJsonAtomic(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

// 侧边栏配置（值班表 / 下载汇总 / 常见问题 / 人员 / 机器人形象）—— 配置中台读写
function loadSidebar() {
  return loadJson(SIDEBAR_PATH, 'sidebar');
}

const WEEK_MAP = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' };

// 计算今日值班：优先精确日期匹配，其次按星期
function todayDuty(sb) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const weekday = WEEK_MAP[now.getDay()];
  const byDate = (sb.onDuty && sb.onDuty.byDate) || {};
  const byWeekday = (sb.onDuty && sb.onDuty.byWeekday) || {};
  const staff = byDate[dateStr] || byWeekday[weekday] || [];
  return { date: dateStr, weekday: weekday, staff: staff };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

function loadConfig() {
  return loadJson(CFG_PATH, 'config');
}

function publicSettings(cfg) {
  return {
    mode: cfg.appId ? 'app' : 'model',
    appId: cfg.appId || '',
    model: cfg.model || '',
    systemPrompt: cfg.systemPrompt || '',
    hasApiKey: Boolean(cfg.apiKey),
    allowedDomains: cfg.allowedDomains || '',
    embedToken: cfg.embedToken || ''
  };
}

// 防盗链白名单解析：支持逗号/空格/换行分隔，忽略协议与路径；空 → 允许任何网站嵌入
function parseAllowedDomains(raw) {
  return String(raw || '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase())
    .filter((item) => /^[a-z0-9*.\-]+(:\d+)?$/i.test(item));
}

// CSP frame-ancestors 由浏览器强制执行：白名单外的站点 iframe 本页会被直接拒绝渲染
function frameAncestorsCsp(cfg) {
  const hosts = parseAllowedDomains(cfg.allowedDomains);
  return hosts.length ? "frame-ancestors 'self' " + hosts.join(' ') : '';
}

function cleanText(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

// ---------- 管理后台登录：钉钉扫码 + 钉钉内免登（移植自 houpe-auth） ----------
function dingtalkCfg(cfg) {
  return {
    appKey: cfg.dingtalkAppKey || process.env.DINGTALK_APP_KEY || '',
    appSecret: cfg.dingtalkAppSecret || process.env.DINGTALK_APP_SECRET || '',
    corpId: cfg.dingtalkCorpId || process.env.DINGTALK_CORP_ID || ''
  };
}
function dingtalkReady(cfg) {
  const d = dingtalkCfg(cfg);
  return Boolean(d.appKey && d.appSecret);
}

// 会话存 sessions.json（原子写），代理重启不掉登录态
let sessions = null;
function loadSessions() {
  if (sessions) return sessions;
  sessions = loadJson(SESSIONS_PATH, 'sessions');
  const now = Date.now();
  for (const sid of Object.keys(sessions)) {
    if (!sessions[sid] || sessions[sid].expires < now) delete sessions[sid];
  }
  return sessions;
}
function saveSessions() {
  try { writeJsonAtomic(SESSIONS_PATH, sessions || {}); }
  catch (e) { console.error('[auth] 会话落盘失败:', e.message || e); }
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) {
      try { out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim()); }
      catch (e) { out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim(); }
    }
  }
  return out;
}
function createSession(user) {
  const store = loadSessions();
  const sid = crypto.randomBytes(32).toString('hex');
  store[sid] = { user: user, expires: Date.now() + SESSION_TTL };
  saveSessions();
  return sid;
}
function sessionUser(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  const entry = loadSessions()[sid];
  if (!entry || entry.expires < Date.now()) return null;
  return entry.user;
}
function destroySession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid && loadSessions()[sid]) {
    delete loadSessions()[sid];
    saveSessions();
  }
}
function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL / 1000));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// 管理员判定（人员设置驱动）：勾选「管理员」的人员可登录后台。
// 匹配顺序：staff.userId（登录时自动记录）→ staff.dingtalkId → 姓名；
// 未配置任何管理员时回退 config.adminUsers（也空则全员可进，便于首次引导配置）。
function inAdminWhitelist(cfg, user) {
  const staff = Array.isArray(loadSidebar().staff) ? loadSidebar().staff : [];
  const admins = staff.filter((s) => s && s.isAdmin);
  if (admins.length) {
    return admins.some((s) =>
      (s.userId && s.userId === user.id) ||
      (s.dingtalkId && s.dingtalkId === user.id) ||
      (s.name && s.name === user.name)
    );
  }
  const allowed = Array.isArray(cfg.adminUsers) ? cfg.adminUsers : [];
  return allowed.length === 0 || allowed.includes(user.id);
}

// 登录成功后把钉钉 userId 自动记到匹配的管理员人员上：
// 首次靠钉钉号/姓名匹配进来，之后精确按 userId 认，改名或钉钉号填错都不影响
function recordStaffUserId(user) {
  const sb = loadSidebar();
  const staff = Array.isArray(sb.staff) ? sb.staff : [];
  const hit = staff.find((s) => s && s.isAdmin && !s.userId &&
    ((s.dingtalkId && s.dingtalkId === user.id) || (s.name && s.name === user.name)));
  if (!hit) return;
  hit.userId = user.id;
  try {
    writeJsonAtomic(SIDEBAR_PATH, sb);
    console.log('[auth] 已自动记录管理员「' + hit.name + '」的钉钉 userId=' + user.id);
  } catch (e) {
    console.error('[auth] 记录 userId 失败:', e.message || e);
  }
}

// 扫码登录 state → { redirect, expires }，防 CSRF；内存即可（5 分钟有效期）
const loginStates = new Map();

function isAdmin(req) {
  if (ADMIN_TOKEN) {
    const supplied = Buffer.from(String(req.headers['x-admin-token'] || ''));
    const expected = Buffer.from(ADMIN_TOKEN);
    if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return true;
  }
  const user = sessionUser(req);
  if (user) {
    const cfg = loadConfig();
    // 已配置钉钉登录时，会话用户必须在白名单内
    if (dingtalkReady(cfg)) return inAdminWhitelist(cfg, user);
    return true;
  }
  // 既无令牌也无钉钉配置 → 维持旧的本地开放行为
  return !ADMIN_TOKEN && !dingtalkReady(loadConfig());
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, { success: false, error: '需要登录管理后台' });
  return false;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  // 不下发跨域头：聊天组件经 iframe 加载、与代理同源；跨域直接调 API 会烧百炼配额，明确不允许
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBodyRaw(req, maxBytes, tooLargeMessage) {
  return new Promise((resolve, reject) => {
    // 先按字节收集、最后一次性解码：请求体里的中文被 TCP 分包切开时，
    // 逐段 += Buffer 会触发逐段 toString('utf8')，把切开的多字节字符替换成 �
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      parts.push(c);
      size += c.length;
      if (size > maxBytes) { reject(new Error(tooLargeMessage)); req.destroy(); }
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
function readBody(req) {
  return readBodyRaw(req, 8 * 1024 * 1024, 'body too large').then((buf) => {
    const raw = buf.toString('utf8');
    try { return raw ? JSON.parse(raw) : {}; }
    catch (e) { throw new Error('invalid JSON body'); }
  });
}

// ---------- 百炼调用：A. 智能体应用 ----------
async function callApp(cfg, prompt, sessionId) {
  const url = 'https://dashscope.aliyuncs.com/api/v1/apps/' + encodeURIComponent(cfg.appId) + '/completion';
  const input = { prompt: prompt };
  if (sessionId) input.session_id = sessionId; // 云端会话记忆（1 小时内有效）
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: input, parameters: {} })
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(mapErr(resp.status, data));
  }
  const out = data.output || {};
  return {
    reply: out.text || '',
    sessionId: out.session_id || sessionId || null,
    usage: data.usage || null
  };
}

function writeSse(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const event = (lines.find((line) => line.startsWith('event:')) || 'event: message').slice(6).trim();
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  if (!data || data === '[DONE]') return { event, done: true };
  try { return { event, data: JSON.parse(data) }; }
  catch (e) { return null; }
}

async function callAppStream(cfg, prompt, sessionId, res) {
  const url = 'https://dashscope.aliyuncs.com/api/v1/apps/' + encodeURIComponent(cfg.appId) + '/completion';
  const input = { prompt: prompt };
  if (sessionId) input.session_id = sessionId;
  const post = (parameters) => fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json',
      'X-DashScope-SSE': 'enable'
    },
    body: JSON.stringify({ input: input, parameters: parameters })
  });
  // has_thoughts 请求返回思考过程；少数旧应用不支持该参数时会报 InvalidParameter，去掉后重试一次
  let resp = await post({ incremental_output: true, has_thoughts: true });
  if (!resp.ok) {
    const errData = await resp.json();
    if (/has_thoughts|InvalidParameter/i.test(String(errData.code || '') + String(errData.message || ''))) {
      resp = await post({ incremental_output: true });
      if (!resp.ok) throw new Error(mapErr(resp.status, await resp.json()));
    } else {
      throw new Error(mapErr(resp.status, errData));
    }
  }

  // 用 stream 模式做流式 UTF-8 解码：中文等多字节字符被 TCP 分包切开时，
  // 逐 chunk toString('utf8') 会把切开的字节替换成 � 甚至弄坏 JSON 导致整块被丢。
  // TextDecoder 的 stream:true 会把不完整的字节序列留到下一个 chunk 再拼。
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentSession = sessionId || null;
  let usage = null;
  let chunkCount = 0;
  let charCount = 0;
  let finishReason = '';
  let sentThought = '';
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      try { resp.body.cancel(); } catch (e) { /* 上游已结束则忽略 */ }
    }
  });

  const handleBlock = (parsed, raw) => {
    if (!parsed) {
      // 报文损坏不能静默丢弃：记下原始块，便于排查“回复被截断”类问题
      console.error('[chat] SSE 块解析失败，已丢弃:', JSON.stringify(raw));
      return;
    }
    if (parsed.done || !parsed.data) return;
    const out = parsed.data.output || {};
    // 上游在流中以 code+message 报错（限流、内容审核、应用异常等），必须透出而不是吞掉
    if (parsed.data.code && parsed.data.message) throw new Error(parsed.data.message);
    const text = out.text || '';
    if (out.session_id) currentSession = out.session_id;
    if (parsed.data.usage) usage = parsed.data.usage;
    if (out.finish_reason) finishReason = out.finish_reason;
    // 思考过程：thoughts 可能整段重发也可能增量，按前缀对齐后只发增量，对不齐则整段替换
    const thoughts = Array.isArray(out.thoughts) ? out.thoughts.map((t) => (t && t.thought) || '').join('') : '';
    if (thoughts) {
      if (thoughts.startsWith(sentThought)) {
        const suffix = thoughts.slice(sentThought.length);
        if (suffix) { writeSse(res, 'thought', { text: suffix }); sentThought = thoughts; }
      } else {
        writeSse(res, 'thought', { text: thoughts, replace: true });
        sentThought = thoughts;
      }
    }
    if (text) {
      writeSse(res, 'chunk', { text: text, session_id: currentSession });
      chunkCount++;
      charCount += text.length;
    }
  };

  for await (const chunk of resp.body) {
    if (clientGone) break;
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      handleBlock(parseSseBlock(block), block);
    }
  }
  buffer += decoder.decode(); // 冲刷残留的不完整多字节字符
  if (buffer.trim()) handleBlock(parseSseBlock(buffer), buffer);
  writeSse(res, 'done', { session_id: currentSession, usage: usage });
  console.log('[chat] 完成 session=' + currentSession + ' 分片=' + chunkCount
    + ' 字符=' + charCount + ' finish=' + (finishReason || '-'));
}

// ---------- 百炼调用：B. 模型直调（OpenAI 兼容） ----------
async function callModel(cfg, messages) {
  const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const msgs = cfg.systemPrompt
    ? [{ role: 'system', content: cfg.systemPrompt }].concat(messages)
    : messages;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: cfg.model, messages: msgs })
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(mapErr(resp.status, data));
  }
  const ch = (data.choices && data.choices[0]) || {};
  return {
    reply: (ch.message && ch.message.content) || '',
    sessionId: null,
    usage: data.usage || null
  };
}

// 模型直调的流式版本：OpenAI 兼容接口 stream:true；思考模型（qwen3 等）额外请求
// enable_thinking 并转发 delta.reasoning_content，不支持的模型报错时去掉该参数重试
async function callModelStream(cfg, messages, res) {
  const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const msgs = cfg.systemPrompt
    ? [{ role: 'system', content: cfg.systemPrompt }].concat(messages)
    : messages;
  const post = (withThinking) => {
    const body = withThinking
      ? { model: cfg.model, messages: msgs, stream: true, enable_thinking: true }
      : { model: cfg.model, messages: msgs, stream: true };
    return fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  };
  let resp = await post(true);
  if (!resp.ok) {
    const errData = await resp.json();
    if (/enable_thinking|InvalidParameter/i.test(String(errData.code || '') + String(errData.message || ''))) {
      resp = await post(false);
      if (!resp.ok) throw new Error(mapErr(resp.status, await resp.json()));
    } else {
      throw new Error(mapErr(resp.status, errData));
    }
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let usage = null;
  let chunkCount = 0;
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      try { resp.body.cancel(); } catch (e) { /* 上游已结束则忽略 */ }
    }
  });
  const handleBlock = (block) => {
    const parsed = parseSseBlock(block);
    if (!parsed) {
      console.error('[chat] SSE 块解析失败，已丢弃:', JSON.stringify(block));
      return;
    }
    if (parsed.done || !parsed.data) return;
    if (parsed.data.usage) usage = parsed.data.usage;
    const choice = (parsed.data.choices && parsed.data.choices[0]) || {};
    const reasoning = (choice.delta && choice.delta.reasoning_content) || '';
    if (reasoning) writeSse(res, 'thought', { text: reasoning });
    const text = (choice.delta && choice.delta.content) || '';
    if (text) {
      writeSse(res, 'chunk', { text: text, session_id: null });
      chunkCount++;
    }
  };
  for await (const chunk of resp.body) {
    if (clientGone) break;
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      handleBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleBlock(buffer);
  writeSse(res, 'done', { session_id: null, usage: usage });
  console.log('[chat] 完成 mode=model 分片=' + chunkCount);
}

function mapErr(status, data) {
  const code = (data && (data.code || data.error && data.error.code)) || '';
  const msg = (data && (data.message || data.error && data.error.message)) || '';
  if (status === 401 || /InvalidApiKey|Unauthorized/i.test(String(code))) {
    return 'API Key 无效或已失效，请到百炼控制台「API-KEY 管理」重新创建';
  }
  if (/Arrearage|Forbidden/i.test(String(code) + String(msg))) {
    return '账户欠费或额度不足，请检查百炼控制台余额';
  }
  if (/AppNotFound|app.*not.*exist|InvalidParameter/i.test(String(code) + String(msg))) {
    return '应用 ID 不正确，或应用尚未发布（Agent 2.0 应用需先发布才能 API 调用）';
  }
  return '百炼服务返回错误（' + status + '）' + (code ? '：' + code : '') + (msg ? ' - ' + msg : '');
}

// ---------- 对话接口限流：按 IP 滑动窗口，防止第三方页面直接刷对话接口烧百炼配额 ----------
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = Number(process.env.CHAT_RATE_LIMIT || 30);
const rateBuckets = new Map(); // ip -> 最近请求时间戳
function tooManyRequests(req) {
  if (!(RATE_LIMIT > 0)) return false;
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  if (rateBuckets.size > 10000) {
    for (const [key, list] of rateBuckets) {
      const alive = list.filter((t) => now - t < RATE_WINDOW_MS);
      if (alive.length) rateBuckets.set(key, alive); else rateBuckets.delete(key);
    }
  }
  const list = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    rateBuckets.set(ip, list);
    return true;
  }
  list.push(now);
  rateBuckets.set(ip, list);
  return false;
}

// ---------- 图片代理防护：拒绝本机/内网目标，避免代理被当作 SSRF 跳板 ----------
// 按主机名/IP 字面量判断；域名解析到内网 IP 的绕过手法防不住，严格场景应在反向代理层再做限制
function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
  }
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}

// ---------- 静态文件 ----------
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    };
    // 防盗链：配置了嵌入白名单后，页面仅允许本站与白名单站点 iframe 展示（悬浮与 iframe 嵌入最终都走 iframe，一并覆盖）
    if (ext === '.html') {
      const csp = frameAncestorsCsp(loadConfig());
      if (csp) headers['Content-Security-Policy'] = csp;
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

// ---------- 主服务 ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 健康检查 / 前端探测连接状态
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/ping') {
    const cfg = loadConfig();
    send(res, 200, {
      success: true,
      mode: cfg.appId ? 'app' : (cfg.model ? 'model' : 'none'),
      configured: Boolean(cfg.apiKey && (cfg.appId || cfg.model)),
      appReady: Boolean(cfg.appId),
      modelReady: Boolean(cfg.model)
    });
    return;
  }

  // 嵌入脚本口令：配置 embedToken 后，/embed.js 必须带 ?token=口令 才下发，
  // 抄走 script 地址但不知道口令的站点连气泡都加载不出（iframe 层另由 frame-ancestors 白名单把守）
  if (req.method === 'GET' && req.url.split('?')[0] === '/embed.js') {
    const cfg = loadConfig();
    if (cfg.embedToken) {
      let supplied = '';
      try { supplied = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; }
      catch (e) { supplied = ''; }
      const expected = String(cfg.embedToken);
      const ok = supplied.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
      if (!ok) { send(res, 403, { error: 'invalid embed token' }); return; }
    }
    serveFile(res, path.join(DIST_ROOT, 'embed.js'));
    return;
  }

  // ---------- 管理后台：钉钉登录 ----------
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/auth/me') {
    const cfg = loadConfig();
    const user = sessionUser(req);
    send(res, 200, {
      success: true,
      loggedIn: Boolean(user),
      user: user ? { id: user.id, name: user.name, avatar: user.avatar } : null,
      dingtalkConfigured: dingtalkReady(cfg),
      corpId: dingtalkCfg(cfg).corpId
    });
    return;
  }

  if (req.method === 'GET' && req.url.split('?')[0] === '/api/auth/dingtalk/url') {
    const cfg = loadConfig();
    if (!dingtalkReady(cfg)) { send(res, 400, { success: false, error: '未配置钉钉登录（dingtalkAppKey / dingtalkAppSecret）' }); return; }
    const redirect = new URL(req.url, 'http://localhost').searchParams.get('redirect') || '/admin';
    if (!redirect.startsWith('/')) { send(res, 400, { success: false, error: 'redirect 必须是站内路径' }); return; }
    const state = crypto.randomBytes(16).toString('hex');
    loginStates.set(state, { redirect: redirect, expires: Date.now() + 5 * 60 * 1000 });
    setTimeout(() => loginStates.delete(state), 5 * 60 * 1000);
    // 回调地址按请求来源推导（反代场景读 X-Forwarded-*），必须与钉钉开放平台「授权回调地址」完全一致
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + PORT);
    const origin = (process.env.PUBLIC_ORIGIN || proto + '://' + host).replace(/\/+$/, '');
    const callbackUrl = origin + '/api/auth/dingtalk/callback';
    send(res, 200, { success: true, url: dingtalk.getQrConnectUrl(callbackUrl, state, dingtalkCfg(cfg).appKey) });
    return;
  }

  if (req.method === 'GET' && req.url.split('?')[0] === '/api/auth/dingtalk/callback') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const state = q.get('state') || '';
    const saved = loginStates.get(state);
    loginStates.delete(state);
    const backTo = saved && saved.redirect.startsWith('/') && saved.redirect !== '/login' ? saved.redirect : '/admin';
    const fail = (msg) => {
      res.writeHead(302, { Location: '/login?redirect=' + encodeURIComponent(backTo) + '&error=' + encodeURIComponent(msg) });
      res.end();
    };
    if (!saved) { fail('登录状态已过期，请重新发起'); return; }
    try {
      const cfg = loadConfig();
      const d = dingtalkCfg(cfg);
      if (!dingtalkReady(cfg)) { fail('服务端未配置钉钉登录'); return; }
      const user = await dingtalk.getUserByCode(q.get('code') || '', d.appKey, d.appSecret);
      if (!inAdminWhitelist(cfg, user)) {
        console.log('[auth] 非白名单登录被拒: ' + user.name + ' (' + user.userId + ')');
        fail('该账号不在管理白名单内');
        return;
      }
      setSessionCookie(res, createSession({ id: user.userId, name: user.name, avatar: user.avatar }));
      recordStaffUserId({ id: user.userId, name: user.name });
      console.log('[auth] 扫码登录: ' + user.name + ' (' + user.userId + ')');
      res.writeHead(302, { Location: backTo });
      res.end();
    } catch (e) {
      console.error('[auth] 扫码回调失败:', e.message);
      fail(e.message || '钉钉登录失败');
    }
    return;
  }

  if (req.method === 'POST' && req.url.split('?')[0] === '/api/auth/dingtalk/auto') {
    const cfg = loadConfig();
    if (!dingtalkReady(cfg)) { send(res, 400, { success: false, error: '未配置钉钉登录' }); return; }
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    if (!body.authCode) { send(res, 400, { success: false, error: '缺少 authCode' }); return; }
    try {
      const d = dingtalkCfg(cfg);
      const user = await dingtalk.getUserByAuthCode(body.authCode, d.appKey, d.appSecret);
      if (!inAdminWhitelist(cfg, user)) {
        console.log('[auth] 非白名单免登被拒: ' + user.name + ' (' + user.userId + ')');
        send(res, 403, { success: false, error: '该账号不在管理白名单内' });
        return;
      }
      setSessionCookie(res, createSession({ id: user.userId, name: user.name, avatar: user.avatar }));
      recordStaffUserId({ id: user.userId, name: user.name });
      console.log('[auth] 钉钉内免登: ' + user.name + ' (' + user.userId + ')');
      send(res, 200, { success: true, user: { id: user.userId, name: user.name, avatar: user.avatar } });
    } catch (e) {
      console.error('[auth] 免登失败:', e.message);
      send(res, 500, { success: false, error: e.message || '钉钉免登失败' });
    }
    return;
  }

  if (req.method === 'POST' && req.url.split('?')[0] === '/api/auth/logout') {
    destroySession(req);
    clearSessionCookie(res);
    send(res, 200, { success: true });
    return;
  }

  // ---------- 管理后台：模型设置（API Key 只写不读） ----------
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/admin/settings') {
    if (!requireAdmin(req, res)) return;
    send(res, 200, { success: true, settings: publicSettings(loadConfig()) });
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/admin/settings') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    const cfg = loadConfig();
    const mode = body.mode === 'model' ? 'model' : 'app';
    const appId = cleanText(body.appId, 200);
    const model = cleanText(body.model, 200);
    if (mode === 'app' && !appId) { send(res, 400, { success: false, error: '智能体模式必须填写应用 ID' }); return; }
    if (mode === 'model' && !model) { send(res, 400, { success: false, error: '模型直调模式必须填写模型名称' }); return; }
    cfg.appId = mode === 'app' ? appId : '';
    cfg.model = mode === 'model' ? model : '';
    cfg.systemPrompt = cleanText(body.systemPrompt, 20000);
    // 仅显式传了才更新：saveAi 不带嵌入配置，不能把已配好的口令/白名单意外清掉
    if (body.allowedDomains !== undefined) cfg.allowedDomains = cleanText(body.allowedDomains, 2000);
    if (body.embedToken !== undefined) cfg.embedToken = cleanText(body.embedToken, 100);
    const apiKey = cleanText(body.apiKey, 500);
    if (apiKey) cfg.apiKey = apiKey;
    if (body.clearApiKey === true) cfg.apiKey = '';
    try {
      writeJsonAtomic(CFG_PATH, cfg);
      send(res, 200, { success: true, settings: publicSettings(cfg) });
    } catch (e) {
      send(res, 500, { success: false, error: '保存失败: ' + (e.message || e) });
    }
    return;
  }

  // ---------- 侧边栏配置中台 ----------
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/sidebar') {
    const sb = loadSidebar();
    send(res, 200, { success: true, config: sb, today: todayDuty(sb) });
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/sidebar') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    const sb = body.config || {};
    sb.onDuty = sb.onDuty || { byDate: {}, byWeekday: {} };
    sb.downloads = Array.isArray(sb.downloads)
      ? sb.downloads.map((item) => ({
          name: cleanText(item && item.name, 50),
          url: cleanText(item && item.url, 500),
          // 下载方式多选：qr=扫码下载 direct=直接下载；旧数据无该字段时默认两种都开
          methods: Array.isArray(item && item.methods)
            ? (item.methods.filter((m) => m === 'qr' || m === 'direct'))
            : ['qr', 'direct']
        }))
        .filter((item) => item.name || item.url)
      : [];
    sb.faq = Array.isArray(sb.faq) ? sb.faq : [];
    // 人员设置：姓名与钉钉号，前端聊天窗口据此唤起钉钉单聊；isAdmin 勾选后可登录管理后台
    sb.staff = Array.isArray(sb.staff)
      ? sb.staff.map((item) => ({
          name: cleanText(item && item.name, 50),
          dingtalkId: cleanText(item && item.dingtalkId, 100),
          isAdmin: Boolean(item && item.isAdmin),
          userId: cleanText(item && item.userId, 100)
        }))
        .filter((item) => item.name || item.dingtalkId)
      : [];
    // 机器人形象：名称、头像与悬浮按钮图（均可为图片 URL 或文字/表情；悬浮按钮图留空时沿用头像）
    const brand = (sb.brand && typeof sb.brand === 'object') ? sb.brand : {};
    sb.brand = { name: cleanText(brand.name, 30), avatar: cleanText(brand.avatar, 500), launcher: cleanText(brand.launcher, 500) };
    try {
      writeJsonAtomic(SIDEBAR_PATH, sb);
      send(res, 200, { success: true, config: sb, today: todayDuty(sb) });
    } catch (e) {
      send(res, 500, { success: false, error: '保存失败: ' + (e.message || e) });
    }
    return;
  }

  // ---------- 图片上传（机器人头像 / 悬浮按钮图等，请求体即原始图片字节） ----------
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/upload') {
    if (!requireAdmin(req, res)) return;
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = UPLOAD_TYPES[type];
    if (!ext) { send(res, 400, { success: false, error: '仅支持 PNG / JPG / GIF / WebP 图片' }); return; }
    let buf;
    try { buf = await readBodyRaw(req, 2 * 1024 * 1024, '图片不能超过 2MB'); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    if (!buf.length) { send(res, 400, { success: false, error: '上传内容为空' }); return; }
    const filename = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + ext;
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
      console.log('[upload] 保存图片 ' + filename + '（' + buf.length + ' 字节）');
      send(res, 200, { success: true, url: '/uploads/' + filename });
    } catch (e) {
      send(res, 500, { success: false, error: '写入文件失败: ' + (e.message || e) });
    }
    return;
  }

  // 上传图片静态服务：文件名本身含随机串，改图即换名，可永久缓存
  if (req.method === 'GET' && req.url.split('?')[0].startsWith('/uploads/')) {
    let relative = '';
    try { relative = decodeURIComponent(req.url.split('?')[0].slice('/uploads/'.length)); }
    catch (e) { relative = ''; }
    if (!UPLOAD_NAME_RE.test(relative)) { send(res, 404, { error: 'not found' }); return; }
    const filePath = path.join(UPLOAD_DIR, relative);
    if (filePath.startsWith(UPLOAD_DIR + path.sep) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable'
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      send(res, 404, { error: 'not found' });
    }
    return;
  }

  // 对话流式接口：智能体应用与模型直调两种模式均支持
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/chat/stream') {
    if (tooManyRequests(req)) { send(res, 429, { success: false, error: '请求过于频繁，请稍后再试' }); return; }
    const cfg = loadConfig();
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    const prompt = body.prompt || (body.messages && body.messages.length
      ? body.messages[body.messages.length - 1].content : '');
    if (!prompt) { send(res, 400, { success: false, error: '缺少提问内容' }); return; }
    const mode = cfg.appId ? 'app' : (cfg.model ? 'model' : 'none');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    writeSse(res, 'ready', { mode: mode });
    console.log('[chat] 收到提问 (' + mode + '):', prompt.slice(0, 120).replace(/\s+/g, ' '));
    try {
      if (!cfg.apiKey) throw new Error('未配置 API Key，请在管理后台或 bailian-proxy/config.json 中填写 apiKey');
      if (mode === 'app') {
        await callAppStream(cfg, prompt, body.session_id || null, res);
      } else if (mode === 'model') {
        const messages = (Array.isArray(body.messages) && body.messages.length)
          ? body.messages
          : [{ role: 'user', content: prompt }];
        await callModelStream(cfg, messages, res);
      } else {
        throw new Error('config.json 中 appId 与 model 均未配置，请在管理后台选择接入模式');
      }
    } catch (e) {
      console.error('[chat] 流式请求失败:', e.message);
      writeSse(res, 'error', { error: e.message || '请求百炼失败' });
    }
    res.end();
    return;
  }

  // 对话接口
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/chat') {
    if (tooManyRequests(req)) { send(res, 429, { success: false, error: '请求过于频繁，请稍后再试' }); return; }
    const cfg = loadConfig();
    if (!cfg.apiKey) {
      send(res, 200, { success: false, error: '未配置 API Key，请在 bailian-proxy/config.json 中填写 apiKey' });
      return;
    }
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }

    const prompt = body.prompt || (body.messages && body.messages.length
      ? body.messages[body.messages.length - 1].content : '');
    if (!prompt) { send(res, 400, { success: false, error: '缺少提问内容' }); return; }

    try {
      let out;
      if (cfg.appId) {
        out = await callApp(cfg, prompt, body.session_id || null);
      } else if (cfg.model) {
        out = await callModel(cfg, body.messages || [{ role: 'user', content: prompt }]);
      } else {
        send(res, 200, { success: false, error: 'config.json 中 appId 与 model 均未配置，请二选一填写' });
        return;
      }
      send(res, 200, {
        success: true,
        reply: out.reply,
        session_id: out.sessionId,
        mode: cfg.appId ? 'app' : 'model',
        usage: out.usage
      });
    } catch (e) {
      send(res, 200, { success: false, error: e.message || '请求百炼失败' });
    }
    return;
  }

  // 图片代理下载（本地开发用）：浏览器跨域拉图受限，由服务端转发解决
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/imgproxy') {
    let target;
    try { target = new URL(new URL(req.url, 'http://localhost').searchParams.get('url') || ''); }
    catch (e) { target = null; }
    if (!target || !/^https?:$/.test(target.protocol)) { send(res, 400, { error: 'url 参数缺失或非法' }); return; }
    const port = target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80);
    if (port !== 80 && port !== 443) { send(res, 403, { error: '仅允许代理 80/443 端口的图片' }); return; }
    if (isBlockedHost(target.hostname)) { send(res, 403, { error: '不允许代理内网或本机地址' }); return; }
    try {
      const r = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 bailian-proxy' } });
      if (!r.ok) { send(res, 502, { error: '源站返回 ' + r.status }); return; }
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': ct,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=3600',
        'X-Img-Proxy': 'bailian'
      });
      res.end(buf);
    } catch (e) {
      send(res, 502, { error: '拉取图片失败: ' + (e.message || e) });
    }
    return;
  }

  // Vue SPA 与 embed.js
  if (req.method === 'GET') {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch (e) { send(res, 400, { error: 'invalid URL' }); return; }
    if (pathname.startsWith('/api/')) { send(res, 404, { error: 'not found' }); return; }
    const relative = path.normalize(pathname).replace(/^([/\\])+/, '');
    const filePath = path.join(DIST_ROOT, relative);
    if (!filePath.startsWith(DIST_ROOT + path.sep) && filePath !== DIST_ROOT) {
      send(res, 403, { error: 'forbidden' });
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      serveFile(res, filePath);
      return;
    }
    if (path.extname(pathname)) { send(res, 404, { error: 'not found' }); return; }
    const indexPath = path.join(DIST_ROOT, 'index.html');
    if (!fs.existsSync(indexPath)) {
      send(res, 503, { error: '前端尚未构建，请先运行 pnpm build' });
      return;
    }
    serveFile(res, indexPath);
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  const cfg = loadConfig();
  const mode = cfg.appId ? '智能体应用 ' + cfg.appId
    : cfg.model ? '模型直调 ' + cfg.model : '未配置（等待填写 config.json）';
  console.log('');
  console.log('  中通冷链 AI 智能助理 · 百炼代理已启动');
  console.log('  ─────────────────────────────────────────');
  console.log('  气泡地址 : http://localhost:' + PORT + '/');
  console.log('  管理后台 : http://localhost:' + PORT + '/admin');
  console.log('  嵌入脚本 : http://localhost:' + PORT + '/embed.js');
  console.log('  接入模式 : ' + mode);
  console.log('  Key 状态 : ' + (cfg.apiKey ? '已配置' : '未配置'));
  console.log('  ─────────────────────────────────────────');
  const bootCfg = loadConfig();
  const bootAdmins = (Array.isArray(loadSidebar().staff) ? loadSidebar().staff : []).filter((s) => s && s.isAdmin);
  console.log('  管理鉴权 : ' + (dingtalkReady(bootCfg)
    ? bootAdmins.length
      ? '钉钉登录已启用（管理员 ' + bootAdmins.length + ' 人，其余钉钉用户禁止登录）'
      : '钉钉登录已启用（未配置管理员，登录后请到「人员设置」勾选）'
    : ADMIN_TOKEN ? '已启用 ADMIN_TOKEN' : '未启用（仅建议本地/内网使用）'));
  console.log('  对话限流 : ' + (RATE_LIMIT > 0 ? '每 IP ' + RATE_LIMIT + ' 次/分钟' : '未启用'));
  console.log('');
});
