# 中通冷链 AI 智能助理

内嵌到第三方页面的 AI 对话气泡 + 管理后台。Node.js 代理保护百炼 API Key，Vue 前端构建产物由代理直接托管。

## 功能

- **对话气泡**：右下角悬浮、可按住拖动换位（松手即停不吸附、按站点记忆位置），SSE 流式回复，可最小化/最大化/嵌入第三方页面（见 `docs/EMBEDDING.md`）
- **管理后台**（`/admin`）：模型接入、机器人形象（名称/头像）、值班表、人员设置（钉钉号）、下载汇总、常见问题
- **钉钉唤起**：为值班人员配置钉钉号后，聊天窗口中点击姓名直接拉起钉钉单聊（`dingtalk://dingtalkclient/action/sendmsg?dingtalk_id=…`，钉钉号在钉钉客户端「我的 → 我的信息」查看）
- **今日值班**：按精确日期优先、星期兜底展示当日技术支持人员；移动端在对话区顶部展示
- **后台管理员**：管理后台「人员设置」中勾选「管理员」的钉钉用户才能登录后台；首次登录时自动记录其钉钉 userId，之后按 userId 精确匹配（改名/钉钉号填错不影响）。一个管理员都没勾选时全员可登录，便于首次引导

## 快速开始

```bash
pnpm install        # 安装依赖
pnpm build          # 构建前端到 dist/（改完前端必须重新构建）
pnpm start          # 启动代理，默认端口 8787（PORT 环境变量可覆盖）
```

- 气泡地址：http://localhost:8787/
- 管理后台：http://localhost:8787/admin
- 嵌入脚本：http://localhost:8787/embed.js

开发模式：`pnpm dev`（Vite 5173，`/api` 自动代理到 8787，需同时跑 `pnpm dev:server`）。

## 部署（新服务器）

面向一台全新的 Linux 服务器（命令按 Ubuntu/Debian 写）。旧线上实例 `https://aitalk.beta.ztocc.com` 仅作参考，新环境把域名、IP、证书换成自己的即可。

运行形态：一个 Node 进程（`bailian-proxy/server.js`，**零外部依赖**）监听 `8787`，托管 `dist/` 和 API；前面由 nginx 终结 HTTPS 并转发 SSE。

```
/opt/ai-assistant/
├── bailian-proxy/     # server.js、dingtalk.js、config.json、sidebar.json、uploads/
└── dist/              # 前端构建产物（必须与 bailian-proxy 同级）
```

### 1. 服务器准备

```bash
apt update
apt install -y nginx certbot python3-certbot-nginx curl ca-certificates
# Node 20+（服务器只跑代理；前端构建在本地做）
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
```

国内下载慢可换 npmmirror 的 Node 二进制或清华 Nodesource 镜像。

### 2. 本地构建

```bash
git clone https://github.com/liyong11/zhongtong-lenglian-ai-assistant.git
cd zhongtong-lenglian-ai-assistant
pnpm install
pnpm test && pnpm build
```

构建机需要 Node ≥ 20.19 或 ≥ 22.12（Vite 7 要求），产物在 `dist/`。

### 3. 上传运行文件

只传运行必需文件，**不要整仓上传**：

```bash
ssh root@<新服务器IP> 'mkdir -p /opt/ai-assistant/bailian-proxy'
rsync -az --partial \
  bailian-proxy/server.js bailian-proxy/dingtalk.js bailian-proxy/config.example.json \
  root@<新服务器IP>:/opt/ai-assistant/bailian-proxy/
rsync -az --partial --exclude .DS_Store dist/ \
  root@<新服务器IP>:/opt/ai-assistant/dist/
```

不要上传本地的 `config.json`、`sidebar.json`、`sessions.json`、`uploads/`、`*.log`：前者是敏感线上配置，后者是旧环境的运行时数据（新环境从空开始，由后台生成）。

### 4. 创建配置

```bash
ssh root@<新服务器IP> '
  cd /opt/ai-assistant/bailian-proxy &&
  cp config.example.json config.json &&
  chmod 600 config.json &&
  vi config.json'
```

最少填 `apiKey`，并填 `appId`（智能体应用，推荐）或 `model`（模型直调）之一。字段说明见下方「配置」。之后所有修改都走 `/admin`，不再手改文件。

> 公网部署必须开启鉴权：配钉钉凭据（`dingtalkAppKey` / `dingtalkAppSecret`）或设 `ADMIN_TOKEN`。两者都不配时，管理后台对本机开放。

### 5. systemd 常驻

```bash
cat >/etc/systemd/system/ai-assistant.service <<'EOF'
[Unit]
Description=ZTO Cold Chain AI Assistant
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/ai-assistant/bailian-proxy
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=PORT=8787
Environment=PUBLIC_ORIGIN=https://<你的域名>
Environment=CHAT_RATE_LIMIT=30
Environment=SSE_MAX_CONCURRENT=100

[Install]
WantedBy=multi-user.target
EOF

chown -R www-data:www-data /opt/ai-assistant
chmod 600 /opt/ai-assistant/bailian-proxy/config.json
systemctl daemon-reload
systemctl enable --now ai-assistant
systemctl status ai-assistant --no-pager
```

- `PUBLIC_ORIGIN` 必填最终 HTTPS 地址，钉钉回调地址按它生成。
- `command -v node` 若不是 `/usr/bin/node`（nvm 安装），把 `ExecStart` 改成实际路径。
- 改完变量或代码：`systemctl restart ai-assistant`；日志 `journalctl -u ai-assistant -f`。
- 团队统一用 pm2 时，可改为 `pm2 start server.js --name ai-assistant && pm2 save`，与 systemd 二选一。

### 6. nginx + HTTPS

先写 HTTP vhost（`ai.example.com` 换成你的域名），`/etc/nginx/sites-available/ai-assistant.conf`：

```nginx
server {
    listen 80;
    server_name ai.example.com;
    client_max_body_size 10m;

    # SSE 流式对话：关缓冲、拉长读超时
    location = /api/chat/stream {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/ai-assistant.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# DNS 的 A 记录先指向新服务器 IP，再签证书
certbot --nginx -d ai.example.com --redirect
```

certbot 会复制上面的 server 块加 443 和证书，location 里的 SSE 设置会保留；证书自动续期。

> 用宝塔面板时：vhost 放 `/www/server/panel/vhost/nginx/`，证书在面板申请，location 内容照抄。

### 7. 防火墙

安全组/防火墙只放行 22、80、443；**不要放行 8787**，应用只给 nginx 本机反代。

### 8. 钉钉（启用钉钉登录时）

- 开放平台 → 应用开发 → 登录与分享 → 授权回调地址：`https://<你的域名>/api/auth/dingtalk/callback`
- 应用开发 → 安全设置 → 服务器出口 IP：加入新服务器公网出口 IP（服务器上 `curl -s ifconfig.me` 查看），否则报 `60020 访问ip不在白名单之中`。
- 需要限制哪些站点能嵌入气泡：`/admin` 填「允许嵌入域名」；开了 `embedToken` 后引用 `/embed.js` 要带 `?token=`。

### 9. 验证

```bash
curl -fsS https://<你的域名>/api/ping
# {"success":true,"mode":"app","configured":true,...}
curl -fsSI https://<你的域名>/embed.js | head -1
```

再打开 `https://<你的域名>/`（气泡）、`/admin`（后台）、第三方引用页，实际发一条消息确认逐字流式正常。首次登录后台后，立刻在「人员设置」勾选管理员（一个都没勾选时全员可登录，属首次引导逻辑）。

### 10. 日常发布

```bash
pnpm test && pnpm build

# sidebar.json 是后台可改的运行时数据：服务器上已生成时先回拉，避免发布覆盖线上配置
scp root@<新服务器IP>:/opt/ai-assistant/bailian-proxy/sidebar.json bailian-proxy/sidebar.json 2>/dev/null || true

rsync -az --partial \
  bailian-proxy/server.js bailian-proxy/dingtalk.js bailian-proxy/sidebar.json \
  bailian-proxy/config.example.json \
  root@<新服务器IP>:/opt/ai-assistant/bailian-proxy/
rsync -az --partial --exclude .DS_Store dist/ \
  root@<新服务器IP>:/opt/ai-assistant/dist/

ssh root@<新服务器IP> 'chown -R www-data:www-data /opt/ai-assistant && systemctl restart ai-assistant'
curl -fsS https://<你的域名>/api/ping
```

`chown` 不能省：rsync 以 root 落盘，而进程是 `www-data`，不 chown 后台就写不了 `sidebar.json`。`dist/` 同步不要加 `--delete`：已打开的页面还在引用旧 hash chunk。

### 11. 迁移旧环境（可选）

从旧服务器只取三样：`bailian-proxy/config.json`（API Key/钉钉凭据）、`bailian-proxy/sidebar.json`（值班表/FAQ/人员/形象）、`bailian-proxy/uploads/`（头像）。上传后 `chown -R www-data:www-data /opt/ai-assistant && systemctl restart ai-assistant`，再更新钉钉回调地址与出口 IP 白名单。

### 部署红线

- `bailian-proxy/config.json` 含百炼 API Key 与钉钉凭据：只在服务器上存在，权限 600，只能通过 `/admin` 修改，不进 git、不从本地覆盖。
- `sidebar.json`、`sessions.json`、`uploads/`、`*.log` 是运行时数据，发布时用白名单 rsync 避开。
- SSE `/api/chat/stream` 的 `proxy_buffering off`、`proxy_cache off`、`proxy_read_timeout 300s`、`X-Forwarded-Host` 缺一不可，否则逐字流失效或回跳地址错误。
- `PUBLIC_ORIGIN`、钉钉回调地址、DNS 三者必须一致，否则扫码登录报 redirect_uri 错误。

## 配置

`bailian-proxy/config.json`（从 `config.example.json` 复制，**已被 .gitignore 忽略，严禁提交**）：

| 字段 | 说明 |
| --- | --- |
| `apiKey` | 百炼 API Key，必填 |
| `appId` | 智能体应用 ID（推荐，支持云端多轮记忆与人设/知识库） |
| `model` | 模型直调名称（如 `qwen-plus`），与 `appId` 二选一 |
| `systemPrompt` | 模型直调模式的系统提示词 |
| `dingtalkAppKey` / `dingtalkAppSecret` | 钉钉企业内部应用凭据；配置后管理后台强制钉钉登录（扫码 + 钉钉内免登） |
| `dingtalkCorpId` | 企业 CorpId，用于钉钉客户端内自动免登 |
| `adminUsers` | 钉钉 userId 白名单数组；留空表示企业内所有登录用户均可进后台 |
| `allowedDomains` | 允许 iframe 嵌入本组件的站点域名（空格分隔）；留空不限制，由 CSP `frame-ancestors` 生效 |
| `embedToken` | 嵌入口令；设置后 `/embed.js` 必须带 `?token=` 才下发 |

也可用环境变量 `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` / `DINGTALK_CORP_ID` 覆盖钉钉配置。

### 管理后台钉钉登录

登录流程移植自 `houpe-auth` 中央认证服务（`bailian-proxy/dingtalk.js`）：

- **PC 浏览器**：后台展示「使用钉钉登录」→ 跳转钉钉扫码 → 回调 `GET /api/auth/dingtalk/callback` 换取用户信息 → 写入会话（`sessions.json`，7 天有效，重启不掉登录）
- **钉钉客户端内**：自动加载钉钉 JSAPI 免登（`POST /api/auth/dingtalk/auto`），无需扫码
- 鉴权优先级：`X-Admin-Token` 请求头与登录会话任一通过即可；**配置了钉钉凭据后后台强制登录**，两者都未配置时维持旧的本地开放行为
- 退出登录：后台侧栏底部「退出」，调 `POST /api/auth/logout`

**上线前必须在钉钉开放平台登记回调地址**（应用开发 → 登录与分享 → 授权回调地址）：

```
https://你的域名/api/auth/dingtalk/callback
```

回调地址由服务端按请求来源自动推导（反代场景读取 `X-Forwarded-Proto/Host`），也可用 `PUBLIC_ORIGIN` 环境变量固定。本地开发时 localhost 未登记回调，扫码会提示 redirect_uri 错误，属预期；可在钉钉后台临时添加内网穿透地址调试。

**同时检查应用的服务器出口 IP 白名单**（应用开发 → 安全设置 → 服务器出口IP）：钉钉企业内部应用的 topapi（免登、unionId 换姓名）有 IP 白名单限制，部署服务器的公网出口 IP 必须加入，否则报 `60020 访问ip不在白名单之中`。

其余运行时配置（值班表、人员、FAQ、机器人形象等）存于 `bailian-proxy/sidebar.json`，全部通过管理后台维护，无需手工编辑。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 服务端口 |
| `ADMIN_TOKEN` | 空 | 管理后台令牌；生产/内网共享环境务必设置 |
| `CHAT_RATE_LIMIT` | `30` | 对话接口每 IP 每分钟请求上限，`0` 关闭 |
| `SSE_MAX_CONCURRENT` | `50` | 全局 SSE 流并发上限，超出返回 429「咨询人数较多」；2核4G 机器可调到 50~100 |

## 安全说明

- API Key 只存服务端，管理接口对 Key 只写不读
- 对话接口按 IP 限流，且不再下发跨域响应头（组件经 iframe 与代理同源，正常使用不受影响）
- 图片代理 `/api/imgproxy` 拒绝内网/本机地址与 80/443 以外端口；按主机名判断，防不住域名解析到内网 IP 的绕过，严格场景请在反向代理层加固
- 配置写入为原子写（临时文件 + rename），损坏时自动备份为 `*.corrupt-时间戳` 并按空配置运行

## 运维注意事项

- **回答混入模型规划叙述（“我需要先检索知识库…”）**：智能体应用的模型会把内部规划直接写进 `output.text`，与真回答同流推送；百炼控制台调试时会折叠这段，API 对接不会，所以「后台看干净、对接显脏」。代理已按 `thoughts` 数量增加的边界（检索/工具执行完成）把边界前的叙述实时转入「深度思考」面板，正文只保留边界后的内容。**残留限制**：最后一步检索完成后，模型仍可能在回答内部夹带叙述（如“检索到了…”“我需要原样输出。”），此段与真回答之间无任何结构信号，代理无法可靠切分——根治需在百炼后台「人设与回复指令」中加约束：`回复中禁止出现任何关于你的思考、检索或工具调用过程的描述（如"我需要""让我先""检索到了""根据规则"等），直接输出面向用户的最终答案。`
- **应用侧提示词导致的回答质量问题**（如只纠正名称不给答案）：由百炼后台应用编排决定，对接层不介入；同一问题模型可能走“检索”也可能走“仅纠正”，属模型波动，可在指令中明确“涉及下载/链接类问题必须先检索知识库”。

## 目录结构

```
bailian-proxy/   Node 代理（API 转发、静态托管、管理接口）
src/             Vue 前端（ChatWidget 气泡 / AdminView 后台 / 纯函数与单测）
public/          embed.js 嵌入脚本
docs/            EMBEDDING.md 嵌入说明、prototype/ 早期静态原型（仅存档）
dist/            构建产物（git 忽略）
```

## 测试

```bash
pnpm test   # node --test，覆盖 SSE 解析、消息渲染、值班表文本解析
```
