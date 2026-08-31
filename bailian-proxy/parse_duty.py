# -*- coding: utf-8 -*-
"""解析中通冷链值班表 Excel → 侧边栏 onDuty 配置 JSON。
用法: python parse_duty.py <xlsx路径> [输出json路径]
优先解析「排班主数据」长表；缺失时尝试「员工全月排班」宽表。
输出: {"ok":true,"onDuty":{byDate,byWeekday},"meta":{...}} 或 {"ok":false,"error":"..."}
"""
import sys, os, json, datetime

def norm_date(v):
    """日期单元格归一化为 YYYY-MM-DD 字符串"""
    if v is None:
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime('%Y-%m-%d')
    s = str(v).strip()
    # 2026-09-01 / 2026/9/1 / 20260901 / 9月1日 等常见形式
    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%Y%m%d', '%Y.%m.%d'):
        try:
            return datetime.datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    # Excel 序列日期（如 46266）
    try:
        n = float(s)
        base = datetime.date(1899, 12, 30)
        return (base + datetime.timedelta(days=int(n))).strftime('%Y-%m-%d')
    except ValueError:
        pass
    return s

def week_cn(date_str):
    return '星期' + '一二三四五六日'[datetime.date.fromisoformat(date_str).weekday()]

def is_on_duty(shift):
    """排班类型：'休息' / 空 → 不在岗；其他班次 → 在岗"""
    if shift is None:
        return False
    s = str(shift).strip()
    return s != '' and s != '休息'

def parse_main_data(ws):
    """排班主数据：A部门 B姓名 C工号 D用户ID E日期 F年份 G月份 H日期_数字 I星期 J排班类型"""
    by_date = {}
    by_weekday = {}
    staff = set()
    total = rest = 0
    date_from = date_to = None
    for row in ws.iter_rows(min_row=2, values_only=True):
        name = row[1]
        if name is None:
            continue
        date_str = norm_date(row[4])
        shift = row[9] if len(row) > 9 else None
        if date_str is None:
            continue
        staff.add(str(name).strip())
        total += 1
        if is_on_duty(shift):
            by_date.setdefault(date_str, []).append(str(name).strip())
            by_weekday.setdefault(week_cn(date_str), []).append(str(name).strip())
            if date_from is None or date_str < date_from:
                date_from = date_str
            if date_to is None or date_str > date_to:
                date_to = date_str
        else:
            rest += 1
    for k in by_weekday:
        by_weekday[k] = sorted(set(by_weekday[k]))
    for k in by_date:
        by_date[k] = sorted(set(by_date[k]))
    return by_date, by_weekday, staff, total, rest, date_from, date_to

def parse_month_grid(ws):
    """员工全月排班：A部门 B姓名 C工号 D用户ID E..AH = 日期列头，格值=班次"""
    header = None
    dates = []
    by_date = {}
    staff = set()
    total = rest = 0
    for row in ws.iter_rows(min_row=1, values_only=True):
        if row[0] is None and row[1] is None:
            continue
        if header is None:
            header = row
            for v in row[4:]:
                d = norm_date(v)
                if d:
                    dates.append(d)
            continue
        name = row[1]
        if name is None:
            continue
        staff.add(str(name).strip())
        for i, d in enumerate(dates):
            shift = row[4 + i] if len(row) > 4 + i else None
            if shift is None or str(shift).strip() == '':
                continue
            total += 1
            if is_on_duty(shift):
                by_date.setdefault(d, []).append(str(name).strip())
            else:
                rest += 1
    for k in by_date:
        by_date[k] = sorted(set(by_date[k]))
    by_weekday = {}
    for d in by_date:
        by_weekday.setdefault(week_cn(d), set()).update(by_date[d])
    for k in by_weekday:
        by_weekday[k] = sorted(by_weekday[k])
    date_from = min(dates) if dates else None
    date_to = max(dates) if dates else None
    return by_date, by_weekday, staff, total, rest, date_from, date_to

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'error': '缺少 xlsx 路径参数'}, ensure_ascii=False))
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.exists(path):
        print(json.dumps({'ok': False, 'error': '文件不存在: %s' % path}, ensure_ascii=False))
        sys.exit(1)
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        if '排班主数据' in wb.sheetnames:
            by_date, by_weekday, staff, total, rest, d_from, d_to = parse_main_data(wb['排班主数据'])
            used_sheet = '排班主数据'
        elif '员工全月排班' in wb.sheetnames:
            by_date, by_weekday, staff, total, rest, d_from, d_to = parse_month_grid(wb['员工全月排班'])
            used_sheet = '员工全月排班'
        else:
            # 兜底：取第一个工作表尝试长表
            by_date, by_weekday, staff, total, rest, d_from, d_to = parse_main_data(wb.worksheets[0])
            used_sheet = wb.sheetnames[0]
        out = {
            'ok': True,
            'usedSheet': used_sheet,
            'onDuty': {'byDate': by_date, 'byWeekday': by_weekday},
            'meta': {
                'staff': sorted(staff),
                'staffCount': len(staff),
                'records': total,
                'restRecords': rest,
                'dateFrom': d_from,
                'dateTo': d_to,
                'dutyDates': len(by_date),
            },
        }
        text = json.dumps(out, ensure_ascii=False)
        if len(sys.argv) > 2:
            with open(sys.argv[2], 'w', encoding='utf-8') as f:
                f.write(text)
        else:
            print(text)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}, ensure_ascii=False))
        sys.exit(1)

if __name__ == '__main__':
    main()
