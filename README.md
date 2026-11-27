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

## 部署（Docker）

双端口部署：公共端口 `8787` 只服务气泡、对话和嵌入脚本；管理端口 `8788` 只服务 `/admin` 后台。管理端口默认不对外，给内网用时改绑定地址并限制防火墙。服务器只要 Docker。

```
用户/公网 → app:8787（气泡、对话、embed.js）
内网      → app:8788（/admin 后台）
两者共用 /data（配置、会话、上传文件）
```

> 以后要挂到 HTTPS 域名后面，见文末「可选：放到 HTTPS 后面」。

### 0. 准备清单

- 一台 Linux 服务器（Ubuntu 22.04/24.04，2 核 4G 起），能 SSH 登录
- 安全组/防火墙放行 `22`、`8787`；`8788` 只对內网开放，**不要对公网放行**
- 百炼 `apiKey`，以及智能体应用 `appId`（或模型名 `model`）
- 钉钉应用凭据（可选；纯 HTTP 部署先不要启用钉钉登录，见第 7 步）

下面命令默认以 `root` 执行；用普通用户时自行加 `sudo`。先设部署目录：

```bash
export APP_DIR=/opt/ai-assistant
```

### 1. 安装 Docker

```bash
apt update
apt install -y git curl
curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun
systemctl enable --now docker
docker --version
docker compose version
```

两条版本命令都有输出即可。`docker compose` 报不存在时：`apt install -y docker-compose-plugin`。

### 2. 拉代码

```bash
git clone https://github.com/liyong11/zhongtong-lenglian-ai-assistant.git "$APP_DIR"
cd "$APP_DIR"
```

目录已存在时改成 `cd "$APP_DIR" && git pull`。

### 3. 配置端口和后台口令

```bash
cp .env.example .env
vi .env
```

最少确认这几项：

```dotenv
APP_PORT=8787            # 公共端口：气泡、对话、嵌入脚本
APP_BIND=0.0.0.0         # 公共端口直接对外；只让本机反代时改 127.0.0.1
ADMIN_PORT=8788          # 管理端口：只服务 /admin
ADMIN_HOST_BIND=127.0.0.1 # 默认仅本机（SSH 隧道访问）；内网直连改内网网卡 IP 或 0.0.0.0
ADMIN_TOKEN=换成一串随机字符
```

- 公共端口访问 `/admin`、`/api/admin/*`、`/api/auth/*` 会直接 404，只有 `8788` 能进后台。
- `ADMIN_HOST_BIND` 控制宿主机把管理端口开到哪：`127.0.0.1` 仅本机，内网访问填内网网卡 IP 或 `0.0.0.0` 并配合安全组。
- `ADMIN_TOKEN` 是 `/admin` 的后台口令，自己编，不是系统生成；`openssl rand -hex 24` 可生成。**分端口模式下必填，未设置会拒绝启动**。
- 钉钉凭据也在 `.env` 里填（`DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` / `DINGTALK_CORP_ID`），见第 7 步。
- HTTP 下令牌是明文传输，内网可以接受；公网管理不建议。

```bash
chmod 600 .env
```

### 4. 首次配置

先建数据目录，再把示例配置复制成正式配置：

```bash
mkdir -p data
cp bailian-proxy/config.example.json data/config.json
chmod 600 data/config.json
vi data/config.json
```

最少改成这样（JSON 不能写注释）：

```json
{
  "apiKey": "sk-你的百炼APIKey",
  "appId": "你的智能体应用ID",
  "model": "",
  "systemPrompt": "你是中通冷链订单管理系统的智能助理「小冷」……",
  "adminUsers": []
}
```

- `appId` 与 `model` 二选一：用百炼智能体应用就填 `appId`、`model` 留空；直调模型就 `appId` 留空、`model` 填如 `qwen-plus`。
- 钉钉凭据不写进 `config.json`，全部放 `.env`（见第 7 步）。
- 检查 JSON 合法性：`python3 -m json.tool data/config.json >/dev/null && echo OK`。

关键一步：容器内进程 uid 是 `1000`，数据目录必须让它可写：

```bash
chown -R 1000:1000 data
chmod 600 data/config.json
```

### 5. 启动

```bash
docker compose up -d --build
```

首次要构建前端镜像，约 2~5 分钟。看状态和日志：

```bash
docker compose ps                    # app 应为 healthy
docker compose logs -f app           # Ctrl+C 退出日志
```

改 `.env` 或 `docker-compose.yml` 后要让容器重建才生效：`docker compose up -d`。

容器时区已固定为 `Asia/Shanghai`，值班日期不会因为服务器时区跑偏。

### 6. 验证

服务器本机：

```bash
curl -fsS http://127.0.0.1:8787/api/ping
# 期望：{"success":true,"mode":"app","configured":true,...}
```

`configured` 为 `false` 说明 `data/config.json` 的 `apiKey`、`appId`/`model` 没填对。

```bash
curl -fsS http://127.0.0.1:8787/embed.js | head -3   # 应输出嵌入脚本
curl -fsSI http://127.0.0.1:8787/ | head -1          # 应返回 200
curl -fsSI http://127.0.0.1:8788/admin | head -1     # 应返回 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/admin  # 应为 404
```

浏览器打开：

- 气泡：`http://<服务器IP>:8787/`
- 后台：`http://<内网IP>:8788/admin`
- 管理端口只绑了 `127.0.0.1` 时，用 SSH 隧道：`ssh -L 8788:127.0.0.1:8788 root@<服务器IP>`，再开 `http://127.0.0.1:8788/admin`

再实测一次流式：

```bash
curl -N -X POST http://127.0.0.1:8787/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"你好"}'
```

应先出现 `event: ready`，随后陆续输出 `data:` 片段。

### 7. 钉钉登录（可选）

⚠️ 分端口模式下后台在 `8788`，而钉钉回调固定走公共域名 `8787`，公共端口又屏蔽了 `/api/auth/*`，所以**分端口部署不要启用钉钉登录**，后台用 `ADMIN_TOKEN`。确实要用钉钉，只能把 `ADMIN_PORT` 留空走单端口模式（后台与气泡同端口，不建议公网）。

以下步骤仅适用于单端口 + 公网 HTTPS；纯 HTTP/IP 也用不了钉钉扫码。

1. 钉钉开放平台创建企业内部应用，记下 `AppKey`、`AppSecret`、企业 `CorpId`，填进 `.env`：
   ```dotenv
   DINGTALK_APP_KEY=dingxxxx
   DINGTALK_APP_SECRET=xxxx
   DINGTALK_CORP_ID=dingxxxx
   ```
   （`config.json` 里对应字段留空即可；两边都填时以 `config.json` 为准。）
2. 「登录与分享」→ 授权回调地址填：`https://你的域名/api/auth/dingtalk/callback`
3. 「安全设置」→ 服务器出口 IP：填服务器公网出口 IP，容器走宿主机 NAT，所以填宿主机的：
   ```bash
   curl -s ifconfig.me
   ```
   不填会报 `60020 访问ip不在白名单之中`。
4. 开通通讯录读取相关权限并发布应用版本，否则扫码后拿不到用户信息。
5. `.env` 里设置 `PUBLIC_ORIGIN=https://你的域名`，再 `docker compose up -d` 让环境变量生效。

回调地址由 `PUBLIC_ORIGIN` 固定，必须和开放平台登记的一字不差。

### 8. 后台初始化

打开 `http://<内网IP>:8788/admin`（管理端口只绑 127.0.0.1 时走 SSH 隧道）：

- 没配钉钉时输入 `.env` 里的 `ADMIN_TOKEN`。
- 第一次登录后立刻到「人员设置」勾选管理员并保存（一个管理员都没勾选时全员可登录，属首次引导逻辑）。
- 依次配置：机器人形象（名称/头像）、值班表、下载汇总、常见问题、人员。
- 需要限制嵌入站点时填「允许嵌入域名」；需要口令时设「嵌入口令」。

所有后台修改都写进 `data/` 目录，重启/重新构建不丢。

### 9. 嵌入第三方页面

在对方页面 `</body>` 前：

```html
<script src="http://<服务器IP>:8787/embed.js" data-title="小冷"></script>
```

设了嵌入口令则用 `.../embed.js?token=口令`。对方站点有 CSP 时放行：

```text
script-src http://<服务器IP>:8787
frame-src http://<服务器IP>:8787
```

⚠️ **对方页面是 HTTPS 时，浏览器会拦截 HTTP 的脚本和 iframe（混合内容）**。这种场景必须给本服务套一层 HTTPS 反代，见下一节。

### 10. 日常更新与回滚

```bash
cd /opt/ai-assistant

# 更新前备份
tar czf "backup-$(date +%F-%H%M).tgz" data .env

git pull
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8787/api/ping
```

回滚到上一个提交：

```bash
git log --oneline -5
git checkout <上一个提交号>
docker compose up -d --build
```

`data/` 不在 git 里，更新和回滚都不会动配置。旧镜像可清理：`docker image prune -f`。

### 11. 备份、恢复、迁移

备份（配置里有 API Key，注意保管）：

```bash
cd /opt/ai-assistant
tar czf "backup-$(date +%F-%H%M).tgz" data .env
```

恢复到新机器：装 Docker → 拉代码 → 解开备份到 `$APP_DIR` → `chown -R 1000:1000 data` → `docker compose up -d --build`。

从旧服务器迁移，只拷三样到 `data/`（路径按旧部署实际目录替换，早期 A 服务器是 `/opt/aitalk/bailian-proxy`）：

```bash
scp root@旧服务器:<旧部署目录>/bailian-proxy/config.json  data/
scp root@旧服务器:<旧部署目录>/bailian-proxy/sidebar.json data/
scp -r root@旧服务器:<旧部署目录>/bailian-proxy/uploads   data/
chown -R 1000:1000 data
docker compose up -d
```

### 12. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 浏览器打不开 `IP:8787` | 安全组/防火墙没放行 8787；`ss -lntp \| grep 8787` 看端口；`docker compose ps` 看容器 |
| 公共端口打开 `/admin` 是 404 | 正常：后台只在 `8788`，公共端口故意屏蔽 |
| 内网打不开 `IP:8788/admin` | `ADMIN_HOST_BIND` 还是 `127.0.0.1`；改成内网网卡 IP 或 `0.0.0.0`，并确认防火墙放行内网访问 |
| 8788 被占用 | `.env` 改 `ADMIN_PORT`，例如 `8790`，再 `docker compose up -d` |
| 8788 能从公网打开 | 立即改 `ADMIN_HOST_BIND` 或安全组，管理端口只应走内网 |
| `docker compose up` 拉镜像超时 | 默认已用 DaoCloud 国内镜像；仍失败时在 `.env` 改 `NODE_IMAGE`，或配 Docker 镜像加速 |
| app 起不来，日志 `EACCES /data` | `chown -R 1000:1000 data` 后 `docker compose restart app` |
| `/api/ping` 的 `configured` 为 false | `data/config.json` 没填 `apiKey` 或没填 `appId`/`model`；改完 `docker compose restart app` |
| 后台没让输令牌就进去了 | `.env` 里 `ADMIN_TOKEN` 为空且没配钉钉。补上后 `docker compose up -d` |
| HTTPS 页面里气泡/脚本被浏览器拦截 | 混合内容限制，给本服务加 HTTPS 反代（下一节） |
| 钉钉报 redirect_uri 错误 | 钉钉登录必须 HTTPS；`PUBLIC_ORIGIN`、回调地址、域名三者一致 |
| 钉钉报 `60020` | 钉钉后台「服务器出口 IP」没加宿主机公网 IP |
| 回答不逐字输出 | 直连容器一般不会；如果前面加了 nginx，确认 SSE location 关闭了 `proxy_buffering` |
| 上传头像失败 | `data/uploads` 权限不对，`chown -R 1000:1000 data` |
| 8787 被占用 | `.env` 里改 `APP_PORT`，例如 `APP_PORT=8790`，再 `docker compose up -d` |
| 配置改坏了 | 服务器会留 `data/config.json.corrupt-时间戳`；从备份恢复或重填 |

常用命令：

```bash
docker compose ps
docker compose logs -f app
docker compose restart app
docker compose down            # 停止（data 不受影响）
docker compose up -d           # 再启动
```

### 13. 可选：放到 HTTPS 后面

公司已有 nginx/网关时：

1. `.env` 改 `APP_BIND=127.0.0.1`（8787 不再对外），设 `PUBLIC_ORIGIN=https://你的域名`，`docker compose up -d`。
2. 反向代理到 `http://127.0.0.1:8787`，SSE 路径 `/api/chat/stream` 要关缓冲：

   ```nginx
   location = /api/chat/stream {
       proxy_pass http://127.0.0.1:8787;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_buffering off;
       proxy_cache off;
       proxy_read_timeout 300s;
   }
   location / {
       proxy_pass http://127.0.0.1:8787;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

3. 嵌入地址、`PUBLIC_ORIGIN` 改用 HTTPS 域名。
4. 只反代 `8787`；后台仍在 `8788` 内网端口，不要一起反代到公网。

### 14. 不想用 Docker

按 git 历史里的 systemd + nginx 方案部署（`git show bb8860f:README.md`），需要服务器装 Node 20+、nginx、certbot。功能一致，步骤更多。

## 配置

`bailian-proxy/config.json`（从 `config.example.json` 复制，**已被 .gitignore 忽略，严禁提交**）：

| 字段 | 说明 |
| --- | --- |
| `apiKey` | 百炼 API Key，必填 |
| `appId` | 智能体应用 ID（推荐，支持云端多轮记忆与人设/知识库） |
| `model` | 模型直调名称（如 `qwen-plus`），与 `appId` 二选一 |
| `systemPrompt` | 模型直调模式的系统提示词 |
| `adminUsers` | 钉钉 userId 白名单数组；留空表示企业内所有登录用户均可进后台 |
| `allowedDomains` | 允许 iframe 嵌入本组件的站点域名（空格分隔）；留空不限制，由 CSP `frame-ancestors` 生效 |
| `embedToken` | 嵌入口令；设置后 `/embed.js` 必须带 `?token=` 才下发 |

钉钉登录凭据不放在这里，用 `.env` 的 `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` / `DINGTALK_CORP_ID`（见部署第 7 步）。旧部署写在 `config.json` 的同名字段仍兼容，且优先级高于环境变量。

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
- 图片代理 `/api/imgproxy` 拒绝内网/本机/云 metadata 地址（含 `100.64.0.0/10`），手动校验每一跳重定向，只接受 `image/*` 且限制 8MB；按主机名判断，防不住恶意域名解析到内网 IP 的绕过，严格场景请在反向代理层封掉该接口
- 配置写入为原子写（临时文件 + rename），损坏时自动备份为 `*.corrupt-时间戳` 并按空配置运行

## 运维注意事项

- **回答混入模型规划叙述（“我需要先检索知识库…”）**：智能体应用的模型会把内部规划直接写进 `output.text`，与真回答同流推送；百炼控制台调试时会折叠这段，API 对接不会，所以「后台看干净、对接显脏」。代理已按 `thoughts` 数量增加的边界（检索/工具执行完成）把边界前的叙述实时转入「深度思考」面板，正文只保留边界后的内容。**残留限制**：最后一步检索完成后，模型仍可能在回答内部夹带叙述（如“检索到了…”“我需要原样输出。”），此段与真回答之间无任何结构信号，代理无法可靠切分——根治需在百炼后台「人设与回复指令」中加约束：`回复中禁止出现任何关于你的思考、检索或工具调用过程的描述（如"我需要""让我先""检索到了""根据规则"等），直接输出面向用户的最终答案。`
- **应用侧提示词导致的回答质量问题**（如只纠正名称不给答案）：由百炼后台应用编排决定，对接层不介入；同一问题模型可能走“检索”也可能走“仅纠正”，属模型波动，可在指令中明确“涉及下载/链接类问题必须先检索知识库”。

## 目录结构

```
bailian-proxy/     Node 代理（API 转发、静态托管、管理接口）
src/               Vue 前端（ChatWidget 气泡 / AdminView 后台 / 纯函数与单测）
public/            embed.js 嵌入脚本
docs/              EMBEDDING.md 嵌入说明、prototype/ 早期静态原型（仅存档）
dist/              构建产物（git 忽略）
Dockerfile         多阶段构建：Vite 打包 + Node 运行
docker-compose.yml 单容器 app，对外 8787
.env.example       端口、监听地址、管理令牌、镜像源模板
data/              运行时数据（git 忽略，容器挂到 /data）
```

## 测试

```bash
pnpm test   # node --test，覆盖 SSE 解析、消息渲染、值班表文本解析
```
