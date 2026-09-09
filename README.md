# 中通冷链 AI 智能助理

内嵌到第三方页面的 AI 对话气泡 + 管理后台。Node.js 代理保护百炼 API Key，Vue 前端构建产物由代理直接托管。

## 功能

- **对话气泡**：右下角悬浮，SSE 流式回复，可最小化/最大化/嵌入第三方页面（见 `docs/EMBEDDING.md`）
- **管理后台**（`/admin`）：模型接入、机器人形象（名称/头像）、值班表、人员设置（钉钉号）、下载汇总、常见问题
- **钉钉唤起**：为值班人员配置钉钉号后，聊天窗口中点击姓名直接拉起钉钉单聊（`dingtalk://dingtalkclient/action/sendmsg?dingtalk_id=…`，钉钉号在钉钉客户端「我的 → 我的信息」查看）
- **今日值班**：按精确日期优先、星期兜底展示当日技术支持人员；移动端在对话区顶部展示

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

## 配置

`bailian-proxy/config.json`（从 `config.example.json` 复制，**已被 .gitignore 忽略，严禁提交**）：

| 字段 | 说明 |
| --- | --- |
| `apiKey` | 百炼 API Key，必填 |
| `appId` | 智能体应用 ID（推荐，支持云端多轮记忆与人设/知识库） |
| `model` | 模型直调名称（如 `qwen-plus`），与 `appId` 二选一 |
| `systemPrompt` | 模型直调模式的系统提示词 |

其余运行时配置（值班表、人员、FAQ、机器人形象等）存于 `bailian-proxy/sidebar.json`，全部通过管理后台维护，无需手工编辑。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 服务端口 |
| `ADMIN_TOKEN` | 空 | 管理后台令牌；生产/内网共享环境务必设置 |
| `CHAT_RATE_LIMIT` | `30` | 对话接口每 IP 每分钟请求上限，`0` 关闭 |

## 安全说明

- API Key 只存服务端，管理接口对 Key 只写不读
- 对话接口按 IP 限流，且不再下发跨域响应头（组件经 iframe 与代理同源，正常使用不受影响）
- 图片代理 `/api/imgproxy` 拒绝内网/本机地址与 80/443 以外端口；按主机名判断，防不住域名解析到内网 IP 的绕过，严格场景请在反向代理层加固
- 配置写入为原子写（临时文件 + rename），损坏时自动备份为 `*.corrupt-时间戳` 并按空配置运行

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
