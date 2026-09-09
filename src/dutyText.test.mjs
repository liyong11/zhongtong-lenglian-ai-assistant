import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDuty, parseDuty } from './dutyText.mjs'

test('parseDuty 支持星期别名与多种分隔符', () => {
  const duty = parseDuty('星期一：李勇、乔羽\n礼拜天：韩刚 王五\n周二:李勇，乔羽；韩刚')
  assert.deepEqual(duty.byWeekday['周一'], ['李勇', '乔羽'])
  assert.deepEqual(duty.byWeekday['周日'], ['韩刚', '王五'])
  assert.deepEqual(duty.byWeekday['周二'], ['李勇', '乔羽', '韩刚'])
  assert.equal(Object.keys(duty.byDate).length, 0)
})

test('parseDuty 归一化日期格式（补零、斜杠）', () => {
  const duty = parseDuty('2026-9-2：李勇\n2026/12/25：乔羽')
  assert.deepEqual(duty.byDate['2026-09-02'], ['李勇'])
  assert.deepEqual(duty.byDate['2026-12-25'], ['乔羽'])
})

test('parseDuty 忽略无冒号行与非法星期/日期键', () => {
  const duty = parseDuty('李勇\n周一x：李勇\n2026-13-99：李勇\n周一：')
  assert.deepEqual(duty, { byDate: {}, byWeekday: {} })
})

test('parseDuty 对空输入安全', () => {
  assert.deepEqual(parseDuty(''), { byDate: {}, byWeekday: {} })
  assert.deepEqual(parseDuty(null), { byDate: {}, byWeekday: {} })
})

test('formatDuty 按星期在前、日期升序输出', () => {
  const text = formatDuty({
    byWeekday: { 周三: ['韩刚'], 周一: ['李勇'] },
    byDate: { '2026-10-02': ['乔羽'], '2026-09-30': ['李勇'] },
  })
  assert.equal(text, '周一：李勇\n周三：韩刚\n2026-09-30：李勇\n2026-10-02：乔羽')
})

test('parseDuty(formatDuty(x)) 往返稳定', () => {
  const original = '周一：李勇,乔羽\n2026-09-02：李勇,乔羽,韩刚'
  const roundtrip = formatDuty(parseDuty(original))
  assert.equal(roundtrip, original)
})
