# aitalk 部署说明（A 服务器）

线上地址：<https://aitalk.beta.ztocc.com>（DNS 通配符已指向 A，无需单独解析）。

## 服务器与连接

- 公司服务器 A：`root@121.199.175.111`（aitalk 部署机）
- 个人服务器 B（跳板）：`root@42.192.205.206`
- 连接顺序：**先试直连 A，超时/失败再走 B 跳板**：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 root@121.199.175.111 hostname || \
  ssh -J root@42.192.205.206 -o BatchMode=yes root@121.199.175.111 hostname
```

## A 上的部署布局

| 项 | 值 |
|---|---|
| 应用目录 | `/opt/aitalk`（代码 + dist + bailian-proxy） |
| 进程 | pm2，名字 `aitalk`（`bailian-proxy/server.js`，Node v24 via nvm） |
| 端口 | 127.0.0.1 经 nginx 反代 → `8787`（安全组已屏蔽公网直连 8787） |
| nginx vhost | `/www/server/panel/vhost/nginx/aitalk.beta.ztocc.com.conf`（宝塔目录） |
| 证书 | 通配符 `/www/server/panel/vhost/letsencrypt/beta.ztocc.com/`（`*.beta.ztocc.com`，acme 续期） |

后端 `bailian-proxy/server.js` **零外部依赖**（只用 Node 内置模块），无需在 A 上 `pnpm install`。

## 发布步骤

```bash
# 1. 本地门禁 + 构建
pnpm test && pnpm build

# 2. 白名单同步（直连失败就加 -e 'ssh -J root@42.192.205.206'）
#    后端代码：绝不带 config.json / sessions.json / uploads / *.log（线上运行时数据）
rsync -az --partial \
  bailian-proxy/server.js bailian-proxy/dingtalk.js bailian-proxy/sidebar.json \
  bailian-proxy/config.example.json \
  root@121.199.175.111:/opt/aitalk/bailian-proxy/

# 3. 前端产物：不带 --delete，旧 hash chunk 留存供已打开页面引用
rsync -az --partial --exclude .DS_Store dist/ \
  root@121.199.175.111:/opt/aitalk/dist/

# 4. 重启 + 验证
ssh root@121.199.175.111 'export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH;
  pm2 restart aitalk --update-env && pm2 save'
curl -fsS https://aitalk.beta.ztocc.com/api/ping   # {"success":true,...}
```

## nginx 要点（SSE）

`/api/chat/stream` 是 SSE 流式对话，vhost 中该 location 必须保持：

- `proxy_buffering off` + `proxy_cache off`（否则流被缓冲、气泡逐字失效）
- `proxy_read_timeout 300s`（长对话不掐断）
- `proxy_set_header X-Forwarded-Host $host`（server.js 依赖它生成回跳地址）

## 环境变量

线上已注入：`SSE_MAX_CONCURRENT=100`（2026-11-02 压测后由 50 上调，60 并发实测 CPU 仅 6%）、`CHAT_RATE_LIMIT=30`。

调整方法（注意：pm2 的 `--update-env` 只增不改不清，改值必须显式重设全部变量）：

```bash
ssh root@121.199.175.111 'export PATH=/root/.nvm/versions/node/v24.11.0/bin:$PATH;
  SSE_MAX_CONCURRENT=100 CHAT_RATE_LIMIT=30 pm2 restart aitalk --update-env && pm2 save'
# 验证（进程真实环境，比 pm2 env 可靠）：
cat /proc/$(pgrep -f bailian-proxy/server.js | head -1)/environ | tr "\0" "\n" | grep -E "^SSE|^CHAT"
```

## 注意

- `/opt/aitalk/bailian-proxy/config.json` 是线上配置（含 API Key、钉钉凭据、白名单），只能通过管理后台 `/admin` 修改，**绝不从本地覆盖**。
- `uploads/` 是运行时上传的机器人头像，rsync 白名单天然避开它。
- 嵌入脚本 `/embed.js` 若配置了 `embedToken`，外站引用需带 `?token=`。
