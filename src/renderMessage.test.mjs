import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMessage } from './renderMessage.mjs'

test('renders common Markdown safely and proxies remote images', () => {
  const html = renderMessage('**重点**\n\n* 第一项\n* 第二项\n\n![轨迹](https://example.com/a.png?x=1)\n\n<script>alert(1)</script>')
  assert.match(html, /<strong>重点<\/strong>/)
  assert.match(html, /<ul>[\s\S]*<li>第一项<\/li>/)
  assert.match(html, /src="\/api\/imgproxy\?url=https%3A%2F%2Fexample.com%2Fa.png%3Fx%3D1"/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('strips knowledge-base citation markers but keeps surrounding text', () => {
  const html = renderMessage('自提码进行查询[^1]。\n\n查看物流轨迹[^1][^2]了解状态。')
  assert.match(html, /自提码进行查询。/)
  assert.match(html, /查看物流轨迹了解状态。/)
  assert.doesNotMatch(html, /\[\^/)
})

test('keeps footnote definition text while dropping the marker', () => {
  const html = renderMessage('[^1]: 中通冷链操作手册\n\n正文[^1]')
  assert.match(html, /中通冷链操作手册/)
  assert.doesNotMatch(html, /\[\^/)
})

test('markdown 和裸链接均渲染为可点击的新标签页链接', () => {
  const html = renderMessage('[操作手册](https://example.com/manual)\n\n详情见 https://example.com/faq')
  assert.match(html, /<a href="https:\/\/example.com\/manual" target="_blank" rel="noopener noreferrer">操作手册<\/a>/)
  assert.match(html, /<a href="https:\/\/example.com\/faq" target="_blank" rel="noopener noreferrer">/)
})

test('全角括号的伪 markdown 链接会被归一并渲染为链接', () => {
  const html = renderMessage('请看[下载页面]（https://example.com/dl）')
  assert.match(html, /<a href="https:\/\/example.com\/dl" target="_blank" rel="noopener noreferrer">下载页面<\/a>/)
})
