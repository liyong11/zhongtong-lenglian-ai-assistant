import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const renderImage = markdown.renderer.rules.image

markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const src = tokens[index].attrGet('src')
  if (/^https?:\/\//i.test(src || '')) tokens[index].attrSet('src', `/api/imgproxy?url=${encodeURIComponent(src)}`)
  tokens[index].attrSet('loading', 'lazy')
  tokens[index].attrJoin('class', 'message-image')
  return renderImage(tokens, index, options, env, self)
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
  return markdown.render(stripCitations(String(content || '')))
}
