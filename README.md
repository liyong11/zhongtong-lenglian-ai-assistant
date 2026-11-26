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

## 部署（Linux 服务器）

线上：<https://aitalk.beta.ztocc.com>（`*.beta.ztocc.com` 通配符证书，DNS 无需单独解析）。

| 项 | 值 |
| --- | --- |
| 服务器 | 公司 A `root@121.199.175.111`；个人 B（跳板）`root@42.192.205.206` |
| 连接 | 先直连 A，超时再走 B：`ssh -J root@42.192.205.206 root@121.199.175.111` |
| 应用目录 | `/opt/aitalk`（`dist/` + `bailian-proxy/`） |
| 进程 | pm2 名称 `aitalk`；Node v24（nvm：`/root/.nvm/versions/node/v24.11.0/bin`） |
| 端口 | 应用监听 `8787`，仅供 nginx 本机反代；安全组**不要**放行 8787 |
| nginx | `/www/server/panel/vhost/nginx/aitalk.beta.ztocc.com.conf`（宝塔目录） |
| 证书 | `/www/server/panel/vhost/letsencrypt/beta.ztocc.com/`（acme 自动续期，新子域名直接复用） |

后端只用 Node 内置模块，**服务器上不需要 `pnpm install` 或 `node_modules`**；换服务器时把 IP、域名、证书路径换掉，其余步骤相同。

### 首次部署

```bash
# 1. 本地准备（Node ≥ 20、pnpm）并构建
git clone https://github.com/liyong11/zhongtong-lenglian-ai-assistant.git
cd zhongtong-lenglian-ai-assistant
pnpm install
pnpm test && pnpm build          # 产物在 dist/

# 2. 建目录 + 白名单上传（绝不整仓上传）
ssh root@121.199.175.111 'mkdir -p /opt/aitalk/bailian-proxy'
rsync -az --partial \
  bailian-proxy/server.js bailian-proxy/dingtalk.js bailian-proxy/config.example.json \
  root@121.199.175.111:/opt/aitalk/bailian-proxy/
rsync -az --partial --exclude .DS_Store dist/ \
  root@121.199.175.111:/opt/aitalk/dist/

# 3. 首次配置（只填一次，之后全部走 /admin）
ssh root@121.199.175.111 '
  cd /opt/aitalk/bailian-proxy &&
  cp config.example.json config.json && chmod 600 config.json && vi config.json'
  # apiKey 必填；appId 与 model 二选一

# 4. 启动 + 开机自启
ssh root@121.199.175.111 '
  export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH
  cd /opt/aitalk
  pm2 start bailian-proxy/server.js --name aitalk
  pm2 startup       # 若提示未配置，按输出的命令执行一次
  pm2 save'
```

nginx vhost（与线上一致，SSE 相关项不能删）：

```nginx
server {
    listen 80;
    server_name aitalk.beta.ztocc.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name aitalk.beta.ztocc.com;

    ssl_certificate /www/server/panel/vhost/letsencrypt/beta.ztocc.com/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/letsencrypt/beta.ztocc.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 10m;

    # SSE 流式对话：关缓冲、拉长读超时
    location = /api/chat/stream {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
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
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
}
```

放到宝塔 vhost 目录后 `nginx -t && nginx -s reload`（宝塔安装的 nginx，vhost 不在 `/etc/nginx`）。

```bash
# 5. 验证
curl -fsS https://aitalk.beta.ztocc.com/api/ping      # {"success":true,...}
curl -fsSI https://aitalk.beta.ztocc.com/embed.js | head -1
```

配置了钉钉登录时，还要在钉钉开放平台补两处：授权回调地址 `https://aitalk.beta.ztocc.com/api/auth/dingtalk/callback`；安全设置 → 服务器出口 IP 加入 A 的公网出口 IP，否则报 `60020 访问ip不在白名单之中`。

### 日常发布（改代码后）

```bash
pnpm test && pnpm build

# sidebar.json 是后台可改的运行时数据却又被 git 跟踪：先回拉，避免把线上修改覆盖回旧版
scp root@121.199.175.111:/opt/aitalk/bailian-proxy/sidebar.json bailian-proxy/sidebar.json

rsync -az --partial \
  bailian-proxy/server.js bailian-proxy/dingtalk.js bailian-proxy/sidebar.json \
  bailian-proxy/config.example.json \
  root@121.199.175.111:/opt/aitalk/bailian-proxy/
rsync -az --partial --exclude .DS_Store dist/ \
  root@121.199.175.111:/opt/aitalk/dist/

ssh root@121.199.175.111 'export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH;
  pm2 restart aitalk --update-env && pm2 save'
curl -fsS https://aitalk.beta.ztocc.com/api/ping
```

直连超时就给 `ssh` / `scp` / `rsync` 加跳板：`ssh -J root@42.192.205.206 ...`、`rsync -e 'ssh -J root@42.192.205.206' ...`。

### 部署红线

- `bailian-proxy/config.json`（API Key、钉钉凭据、白名单）只存在于服务器，只能通过 `/admin` 修改，**不从本地覆盖、不进 git**。
- `sidebar.json`、`sessions.json`、`uploads/`、`*.log` 是运行时数据，rsync 白名单天然避开；发布前先回拉 `sidebar.json`。
- `dist/` 同步不要加 `--delete`：已打开的页面还在引用旧 hash chunk。
- SSE `/api/chat/stream` 的 `proxy_buffering off`、`proxy_cache off`、`proxy_read_timeout 300s`、`X-Forwarded-Host` 缺一不可，否则逐字流式失效。
- 改环境变量时用 `pm2 restart aitalk --update-env`，但要把所有变量显式重设一遍（`--update-env` 只增不改不清）：

  ```bash
  ssh root@121.199.175.111 'export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH;
    SSE_MAX_CONCURRENT=100 CHAT_RATE_LIMIT=30 pm2 restart aitalk --update-env && pm2 save'
  ```

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
