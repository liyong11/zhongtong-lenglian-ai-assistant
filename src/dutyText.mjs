// 值班表文本 <-> 结构化配置 的双向转换（管理后台「值班表」分区使用）
const WEEKDAY_KEYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function formatDuty(duty) {
  const lines = []
  const weekdays = duty.byWeekday || {}
  WEEKDAY_KEYS.forEach(day => {
    if (weekdays[day]?.length) lines.push(`${day}：${weekdays[day].join(',')}`)
  })
  Object.keys(duty.byDate || {}).sort().forEach(date => {
    if (duty.byDate[date]?.length) lines.push(`${date}：${duty.byDate[date].join(',')}`)
  })
  return lines.join('\n')
}

export function parseDuty(text) {
  const result = { byDate: {}, byWeekday: {} }
  String(text || '').split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([^：:]+)\s*[：:]\s*(.+)$/)
    if (!match) return
    const key = match[1].trim().replace('星期', '周').replace('礼拜', '周').replace('周天', '周日')
    const names = match[2].split(/[,，、;；\s]+/).filter(Boolean)
    if (!names.length) return
    const date = key.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
    const month = date ? Number(date[2]) : 0
    const day = date ? Number(date[3]) : 0
    if (date && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      result.byDate[`${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`] = names
    } else if (WEEKDAY_KEYS.includes(key)) {
      result.byWeekday[key] = names
    }
  })
  return result
}
