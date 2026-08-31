/**
 * 中通冷链 AI 智能助理 —— 百炼模型代理服务器
 *
 * 作用：
 *  1. 解决浏览器 CORS 限制（浏览器不允许直接请求 dashscope.aliyuncs.com）
 *  2. 保护 API Key（Key 只存在本文件同目录的 config.json，绝不下发到前端）
 *  3. 静态托管 prototype.html，保证页面与 /api/chat 同源
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
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..'); // 工作区根目录（prototype.html 所在）
const PORT = process.env.PORT || 8787;
const CFG_PATH = path.join(__dirname, 'config.json');
const SIDEBAR_PATH = path.join(__dirname, 'sidebar.json');
const PARSE_SCRIPT = path.join(__dirname, 'parse_duty.py');

// Excel 解析用 Python（需 openpyxl）：优先系统 Python，兜底 managed
const PY_CANDIDATES = [
  'C:\\Users\\73686\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe',
  'C:\\Users\\73686\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
];

function runPython(args) {
  return new Promise((resolve, reject) => {
    let idx = 0;
    const attempt = () => {
      if (idx >= PY_CANDIDATES.length) {
        reject(new Error('未找到可用的 Python 环境（需要安装 openpyxl 库）'));
        return;
      }
      execFile(PY_CANDIDATES[idx], args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) { idx++; attempt(); return; }
        resolve(stdout);
      });
    };
    attempt();
  });
}

// 侧边栏配置（值班表 / 下载汇总 / 常见问题）—— 配置中台读写
function loadSidebar() {
  try {
    return JSON.parse(fs.readFileSync(SIDEBAR_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
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
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CFG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
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

// ---------- 静态文件 ----------
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

// ---------- 主服务 ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
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

  // ---------- 侧边栏配置中台 ----------
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/sidebar') {
    const sb = loadSidebar();
    send(res, 200, { success: true, config: sb, today: todayDuty(sb) });
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/sidebar') {
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    const sb = body.config || {};
    sb.onDuty = sb.onDuty || { byDate: {}, byWeekday: {} };
    sb.downloads = Array.isArray(sb.downloads) ? sb.downloads : [];
    sb.faq = Array.isArray(sb.faq) ? sb.faq : [];
    try {
      fs.writeFileSync(SIDEBAR_PATH, JSON.stringify(sb, null, 2), 'utf-8');
      send(res, 200, { success: true, config: sb, today: todayDuty(sb) });
    } catch (e) {
      send(res, 500, { success: false, error: '保存失败: ' + (e.message || e) });
    }
    return;
  }

  // 值班表 Excel 导入：前端上传 base64 → 本地 Python(openpyxl) 解析 → 返回 onDuty + 预览
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/sidebar/import-excel') {
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, 400, { success: false, error: e.message }); return; }
    const filename = body.filename || 'import.xlsx';
    const b64 = body.base64 || '';
    if (!/\.(xlsx|xls)$/i.test(filename)) {
      send(res, 400, { success: false, error: '仅支持 .xlsx / .xls 格式的 Excel 值班表' });
      return;
    }
    if (!b64 || b64.length < 100) {
      send(res, 400, { success: false, error: '未读取到文件内容' });
      return;
    }
    if (b64.length > 8 * 1024 * 1024) {
      send(res, 400, { success: false, error: '文件过大（限 8MB）' });
      return;
    }
    const tmpPath = path.join(__dirname, '.tmp-import-' + Date.now() + '.xlsx');
    try {
      fs.writeFileSync(tmpPath, Buffer.from(b64, 'base64'));
      const stdout = await runPython([PARSE_SCRIPT, tmpPath]);
      let parsed;
      try { parsed = JSON.parse(stdout.trim()); }
      catch (e) { parsed = { ok: false, error: '解析器输出异常' }; }
      send(res, 200, parsed);
    } catch (e) {
      send(res, 500, { success: false, error: '解析失败: ' + (e.message || e) });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (e) { /* 忽略清理失败 */ }
    }
    return;
  }

  // 对话接口
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/chat') {
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
    const target = new URL(req.url, 'http://localhost').searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) { send(res, 400, { error: 'url 参数缺失或非法' }); return; }
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

  // 静态托管（默认 prototype.html）
  if (req.method === 'GET') {
    let u = req.url.split('?')[0];
    if (u === '/') u = '/prototype.html';
    const filePath = path.join(ROOT, path.normalize(u).replace(/^([/\\])+/, ''));
    // 防目录穿越
    if (!filePath.startsWith(ROOT)) { send(res, 403, { error: 'forbidden' }); return; }
    serveFile(res, filePath);
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
  console.log('  页面地址 : http://localhost:' + PORT + '/');
  console.log('  接入模式 : ' + mode);
  console.log('  Key 状态 : ' + (cfg.apiKey ? '已配置' : '未配置'));
  console.log('  ─────────────────────────────────────────');
  console.log('  浏览器打开上面地址即可体验真模型对话');
  console.log('');
});
