# 中通冷链 AI 助理嵌入说明

## 1. 最简接入

在第三方系统页面的 `</body>` 前加入：

```html
<script
  src="https://你的AI服务域名/embed.js"
  data-title="小冷"
  data-position="right"
  data-bottom="24"
  data-side="24">
</script>
```

页面会在右下角出现一个 AI 气泡。点击后通过 iframe 展开聊天窗口，最大化、最小化和关闭都由嵌入脚本自动处理。

悬浮球支持按住拖动换位：按住球移动即可拖到页面任意位置，松手即停在该位置（不吸附、不自动贴边）；轻点仍为打开对话。拖动后的位置记忆在**嵌入站点自己的 localStorage**（键 `zto-ai-widget-pos`），各站点互不影响，用户没拖过则回到 script 标签配置的默认角落。聊天窗展开时锚定悬浮球当前位置并保证不出视口。

## 2. 参数

| 属性 | 默认值 | 说明 |
| --- | --- | --- |
| `data-title` | `小冷` | 聊天窗口显示名称 |
| `data-position` | `right` | 气泡位置，支持 `right` / `left` |
| `data-bottom` | `24` | 距页面底部像素数 |
| `data-side` | `24` | 距页面左侧或右侧像素数 |
| `data-z-index` | `2147483000` | iframe 层级 |

## 3. 部署要求

1. 先运行 `pnpm build`，再用 `pnpm start` 启动 Node.js 服务。
2. 第三方页面必须能通过 HTTPS 访问 AI 服务域名。
3. 若站点配置了 CSP，需要放行：

```text
script-src https://你的AI服务域名
frame-src https://你的AI服务域名
```

4. API Key 只保存在服务端 `bailian-proxy/config.json`，嵌入代码和 iframe 不会读取真实 Key。

## 4. 管理后台

后台地址：`https://你的AI服务域名/admin`

生产环境启动时建议设置管理令牌：

```bash
ADMIN_TOKEN='换成高强度随机字符串' pnpm start
```

设置后，修改模型、值班表、下载项和常见问题时必须在后台输入管理令牌。根页面与聊天气泡不会显示后台入口。

## 5. 本地联调

终端一：

```bash
pnpm dev:server
```

终端二：

```bash
pnpm dev
```

访问：

- 气泡：`http://localhost:5173/`
- 管理后台：`http://localhost:5173/admin`
