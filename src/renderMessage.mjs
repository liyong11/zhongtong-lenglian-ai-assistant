import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const renderImage = markdown.renderer.rules.image

// 回答里的链接一律新标签页打开：聊天气泡（尤其嵌入 iframe 时）不允许就地跳转
const defaultLinkOpen = markdown.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const src = tokens[index].attrGet('src')
  if (/^https?:\/\//i.test(src || '')) tokens[index].attrSet('src', `/api/imgproxy?url=${encodeURIComponent(src)}`)
  tokens[index].attrSet('loading', 'lazy')
  tokens[index].attrJoin('class', 'message-image')
  return renderImage(tokens, index, options, env, self)
}

// 百炼应用偶尔输出全角括号的“伪 markdown”链接（如 [文本]（https://…）），归一成标准语法再解析
function normalizeLinks(text) {
  return text.replace(/\]\s*（\s*(https?:\/\/[^）\s]+?)\s*）/g, ']($1)')
}

// 流式回答里长 URL（OSS 文档签名链接等）常被中途断行，解析出的 href 只有前半截，
// 链接能点但打开 403。行尾悬着 http(s):// 连续串、且下一行以纯 URL 字符开头时，把换行拼回去。
// ponytail: 启发式拼接，URL 行尾恰好紧跟英文正文的罕见形态会误拼，出现再收紧
function repairBrokenUrls(text) {
  const endsWithUrl = /https?:\/\/\S*[A-Za-z0-9_\-~.%=/&?#+]$/
  const urlContinuation = /^[A-Za-z0-9_\-~.%=/&?#+]/
  const out = []
  for (const line of text.split('\n')) {
    const prev = out[out.length - 1]
    if (prev !== undefined && endsWithUrl.test(prev) && !/[)）>'"]$/.test(prev)
      && urlContinuation.test(line) && !/^https?:\/\//.test(line)) {
      out[out.length - 1] = prev + line
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

// 百炼知识库应用会在回答里插入 [^1] 式引用标记（不带来源链接），展示前过滤掉
function stripCitations(text) {
  return text
    .split('\n')
    .map(line => {
      const def = line.match(/^\[\^([^\]]+)\]:(.*)$/)
      if (def) return def[2].trim()
      return line.replace(/\[\^[^\]\n]+\]/g, '')
    })
    .join('\n')
}

export function renderMessage(content) {
  return markdown.render(stripCitations(normalizeLinks(repairBrokenUrls(String(content || '')))))
}
