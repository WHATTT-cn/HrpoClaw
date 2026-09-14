/**
 * PO 日记日历板块（履约追踪看板顶部）
 *
 * 与同一看板下方的「用工决策」记录不同，PO 日记是**可写运行时数据**：
 * - 数据文件 `~/.openclaw/workspace-po/PO日记.json`，由主进程 ensurePresetPoDiaryFile() 预置空文档；
 * - 唯一写入方就是本组件的「+」新增表单与条目删除，经 host-api 的 files.writeText 落盘；
 * - 没有 TS 真源、没有生成脚本，因此不会被 `pnpm gen:decisions` 覆盖。
 *
 * 结构：
 * - 头部：年/月选择 + 上/下月翻页 + 刷新 + 「+」新增按钮。
 * - 月视图：7 列网格；一条条目在**下单日期**格标「下单」、在**预期送达日期**格标「预期送达」。
 * - 明细：点击单元格在下方展开当天标记明细，每条附删除按钮（删除的是整条条目）。
 * - 未排期：两个日期都留空（或非法）的条目集中列在日历下方。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { readTextFile, writeTextFile } from '@/lib/file-preview-client';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  MARKER_LABEL,
  PO_DIARY_FILE_PATH,
  createEmptyDraft,
  createEntryId,
  groupMarkersByDate,
  parseDiaryEntries,
  serializeDiary,
  toDateKey,
  type PoDiaryDraft,
  type PoDiaryEntry,
  type PoDiaryMarkerKind,
} from '@/data/po-diary';

/** 周首列到周末列的表头（周日起，与 Date.getDay() 的 0-6 对齐）。 */
const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 年份下拉的可选范围：当前年前后各 3 年，够用且不至于让列表过长。 */
const YEAR_SPAN = 3;

/** 文本类字段定义，集中声明避免多段重复 JSX。 */
const TEXT_FIELDS: Array<{ key: keyof PoDiaryDraft; label: string; placeholder: string }> = [
  { key: 'warehouse', label: '物流仓', placeholder: '如：北京亦庄仓' },
  { key: 'supplier', label: '供应商', placeholder: '如：蓝鲸人力' },
  { key: 'orderType', label: '下单种类', placeholder: '如：日结 / 长期' },
  { key: 'expectedHeadcount', label: '预期送达人数', placeholder: '如：12' },
];

/** 标记类型对应的徽标配色：下单用琥珀色，预期送达用绿色。 */
const MARKER_TONE: Record<PoDiaryMarkerKind, string> = {
  order: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  delivery: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};

/**
 * 生成某年某月的日历格子：前导空位补 null，其余为该月 1..N 日。
 * 用本地时区构造 Date，避免 UTC 偏移导致月首星期错位。
 */
function buildMonthCells(year: number, month: number): Array<number | null> {
  const leading = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(day);
  }
  // 补齐尾部，保证整行对齐（7 的倍数）。
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  return cells;
}

/** 把条目摘要成一行可读文本，供明细区展示。 */
function summarize(entry: PoDiaryEntry): string {
  const parts = [entry.warehouse, entry.supplier, entry.orderType].filter(Boolean);
  if (entry.expectedHeadcount) parts.push(`预期 ${entry.expectedHeadcount} 人`);
  return parts.length > 0 ? parts.join(' · ') : '（未填写其他信息）';
}

/** 条目的两个日期摘要，让用户在删除前确认删的是哪一条。 */
function dateSummary(entry: PoDiaryEntry): string {
  const parts: string[] = [];
  if (entry.orderDate) parts.push(`下单 ${entry.orderDate}`);
  if (entry.expectedDate) parts.push(`预期送达 ${entry.expectedDate}`);
  return parts.length > 0 ? parts.join(' · ') : '未排期';
}

/** 单条明细卡片：标记徽标 + 摘要 + 删除按钮。 */
function DiaryEntryCard({
  entry,
  kind,
  onDelete,
}: {
  entry: PoDiaryEntry;
  /** 有值时展示「下单 / 预期送达」徽标；未排期列表不传。 */
  kind?: PoDiaryMarkerKind;
  onDelete: (entry: PoDiaryEntry) => void;
}) {
  return (
    <div
      data-testid="po-diary-entry"
      className="flex items-start gap-2 rounded-lg border border-black/5 bg-black/[0.02] px-3 py-2 dark:border-white/5 dark:bg-white/[0.02]"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {kind && (
            <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${MARKER_TONE[kind]}`}>
              {MARKER_LABEL[kind]}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground tabular-nums">{dateSummary(entry)}</span>
        </div>
        <p className="mt-1 truncate text-xs text-foreground/80">{summarize(entry)}</p>
      </div>
      <button
        type="button"
        aria-label="删除该条目"
        data-testid="po-diary-delete"
        onClick={() => onDelete(entry)}
        className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function PoDiaryCalendar() {
  const today = useMemo(() => new Date(), []);
  const [entries, setEntries] = useState<PoDiaryEntry[]>([]);
  const [viewYear, setViewYear] = useState(() => today.getFullYear());
  const [viewMonth, setViewMonth] = useState(() => today.getMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<PoDiaryDraft>(() => createEmptyDraft());
  const [pendingDelete, setPendingDelete] = useState<PoDiaryEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await readTextFile(PO_DIARY_FILE_PATH);
      if (!res.ok) {
        // 文件尚未预置（老环境未重启）等同于空日历，不作为错误展示。
        setEntries([]);
        if (res.error && res.error !== 'notFound') {
          setError(`读取失败：${res.error}`);
        }
        return;
      }
      setEntries(parseDiaryEntries(res.content ?? ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 日期 → 标记列表；同一条目会同时出现在下单日与预期送达日两格。 */
  const markersByDate = useMemo(() => groupMarkersByDate(entries), [entries]);
  /** 两个日期都没填的条目，单独列出，避免录入后「找不到」。 */
  const unscheduled = useMemo(
    () => entries.filter((entry) => !entry.orderDate && !entry.expectedDate),
    [entries],
  );
  const cells = useMemo(() => buildMonthCells(viewYear, viewMonth), [viewYear, viewMonth]);
  const todayKey = useMemo(() => toDateKey(today), [today]);
  const yearOptions = useMemo(() => {
    const base = today.getFullYear();
    return Array.from({ length: YEAR_SPAN * 2 + 1 }, (_, i) => base - YEAR_SPAN + i);
  }, [today]);

  /** 翻月：借 Date 自动处理跨年（month 传 -1 / 12 会自动归一）。 */
  const shiftMonth = useCallback(
    (delta: number) => {
      const next = new Date(viewYear, viewMonth + delta, 1);
      setViewYear(next.getFullYear());
      setViewMonth(next.getMonth());
      setSelectedDate(null);
    },
    [viewYear, viewMonth],
  );

  /** 打开新增弹窗；若当前选中了某天，则预填为该天的「下单日期」。 */
  const openDialog = useCallback(() => {
    setDraft(createEmptyDraft(selectedDate ?? ''));
    setDialogOpen(true);
  }, [selectedDate]);

  const updateDraft = useCallback((key: keyof PoDiaryDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  /**
   * 读-改-写的公共落盘逻辑。
   * 重新读一次文件而不是直接用内存 entries，减少多窗口/外部编辑造成的覆盖丢失；
   * writeText 不会创建文件，notFound 时给出可操作提示。
   */
  const persist = useCallback(
    async (mutate: (current: PoDiaryEntry[]) => PoDiaryEntry[]): Promise<void> => {
      const read = await readTextFile(PO_DIARY_FILE_PATH);
      if (!read.ok && read.error !== 'notFound') {
        throw new Error(`读取失败：${read.error ?? '未知错误'}`);
      }
      const next = mutate(parseDiaryEntries(read.content ?? ''));
      const write = await writeTextFile(PO_DIARY_FILE_PATH, serializeDiary(next));
      if (!write.ok) {
        throw new Error(
          write.error === 'notFound'
            ? '数据文件尚未创建，请重启应用完成预置后再试。'
            : `保存失败：${write.error ?? '未知错误'}`,
        );
      }
      setEntries(next);
    },
    [],
  );

  /** 提交新增条目。 */
  const submit = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const entry: PoDiaryEntry = {
        id: createEntryId(),
        warehouse: draft.warehouse.trim(),
        supplier: draft.supplier.trim(),
        orderType: draft.orderType.trim(),
        expectedHeadcount: draft.expectedHeadcount.trim(),
        orderDate: draft.orderDate.trim(),
        expectedDate: draft.expectedDate.trim(),
        createdAt: new Date().toISOString(),
      };
      await persist((current) => [...current, entry]);
      setDialogOpen(false);
      // 写入成功后跳到条目所在月份并选中，便于立刻看到效果。
      const anchor = entry.orderDate || entry.expectedDate;
      if (anchor) {
        const [y, m] = anchor.split('-');
        setViewYear(Number(y));
        setViewMonth(Number(m) - 1);
        setSelectedDate(anchor);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, persist]);

  /** 确认删除：按 id 过滤后整体回写（下单格与送达格会同时消失）。 */
  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const targetId = pendingDelete.id;
    setError(null);
    try {
      await persist((current) => current.filter((item) => item.id !== targetId));
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingDelete(null);
    }
  }, [pendingDelete, persist]);

  const selectedMarkers = selectedDate ? (markersByDate.get(selectedDate) ?? []) : [];

  return (
    <div
      data-testid="po-diary-calendar"
      className="rounded-xl border border-black/5 p-3 dark:border-white/5"
    >
      {/* 头部：标题 + 年月切换 + 刷新 + 新增 */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold text-foreground">PO 日记</h3>
        <button
          type="button"
          aria-label="上一月"
          onClick={() => shiftMonth(-1)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <Select
          aria-label="选择年份"
          value={String(viewYear)}
          onChange={(e) => {
            setViewYear(Number(e.target.value));
            setSelectedDate(null);
          }}
          className="h-7 w-[88px] text-xs"
        >
          {yearOptions.map((year) => (
            <option key={year} value={year}>
              {year} 年
            </option>
          ))}
        </Select>
        <Select
          aria-label="选择月份"
          value={String(viewMonth)}
          onChange={(e) => {
            setViewMonth(Number(e.target.value));
            setSelectedDate(null);
          }}
          className="h-7 w-[76px] text-xs"
        >
          {Array.from({ length: 12 }, (_, i) => i).map((month) => (
            <option key={month} value={month}>
              {month + 1} 月
            </option>
          ))}
        </Select>
        <button
          type="button"
          aria-label="下一月"
          onClick={() => shiftMonth(1)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="刷新 PO 日记"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          aria-label="新增日记条目"
          data-testid="po-diary-add"
          onClick={openDialog}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors hover:bg-primary/20"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* 星期表头 */}
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
        {WEEK_LABELS.map((label) => (
          <div key={label}>{label}</div>
        ))}
      </div>

      {/* 月视图 */}
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((day, index) => {
          if (day === null) {
            return <div key={`blank-${index}`} className="min-h-[62px]" />;
          }
          const key = toDateKey(new Date(viewYear, viewMonth, day));
          const dayMarkers = markersByDate.get(key) ?? [];
          const isToday = key === todayKey;
          const isSelected = key === selectedDate;
          return (
            <button
              key={key}
              type="button"
              data-testid="po-diary-cell"
              data-date={key}
              onClick={() => setSelectedDate(isSelected ? null : key)}
              className={`min-h-[62px] rounded-lg border p-1 text-left transition-colors ${
                isSelected
                  ? 'border-primary/60 bg-primary/5'
                  : 'border-black/5 hover:bg-black/[0.03] dark:border-white/5 dark:hover:bg-white/[0.04]'
              }`}
            >
              <span
                className={`block text-[11px] tabular-nums ${
                  isToday ? 'font-semibold text-primary' : 'text-muted-foreground'
                }`}
              >
                {day}
              </span>
              <span className="mt-0.5 block space-y-0.5">
                {dayMarkers.slice(0, 2).map((marker) => (
                  <span
                    key={`${marker.entry.id}-${marker.kind}`}
                    className={`block truncate rounded px-1 py-0.5 text-[10px] leading-tight ${MARKER_TONE[marker.kind]}`}
                  >
                    {MARKER_LABEL[marker.kind]}
                  </span>
                ))}
                {dayMarkers.length > 2 && (
                  <span className="block px-1 text-[10px] text-muted-foreground">
                    +{dayMarkers.length - 2}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* 选中日明细 */}
      {selectedDate && (
        <div data-testid="po-diary-detail" className="mt-3 space-y-2">
          <p className="text-xs font-medium text-foreground">
            {selectedDate} 明细（{selectedMarkers.length} 条）
          </p>
          {selectedMarkers.length === 0 ? (
            <p className="text-xs text-muted-foreground">当天暂无条目，可点击右上角「+」新增。</p>
          ) : (
            selectedMarkers.map((marker) => (
              <DiaryEntryCard
                key={`${marker.entry.id}-${marker.kind}`}
                entry={marker.entry}
                kind={marker.kind}
                onDelete={setPendingDelete}
              />
            ))
          )}
        </div>
      )}

      {/* 未排期条目 */}
      {unscheduled.length > 0 && (
        <div data-testid="po-diary-unscheduled" className="mt-3 space-y-2">
          <p className="text-xs font-medium text-foreground">未排期（{unscheduled.length} 条）</p>
          {unscheduled.map((entry) => (
            <DiaryEntryCard key={entry.id} entry={entry} onDelete={setPendingDelete} />
          ))}
        </div>
      )}

      {/* 新增条目弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md bg-surface-modal p-4">
          <DialogTitle className="text-sm font-semibold">新增 PO 日记条目</DialogTitle>
          <DialogDescription className="mt-1 text-xs text-muted-foreground">
            所有字段均非必填，两个日期都留空的条目会归入日历下方「未排期」。
          </DialogDescription>
          <div className="mt-3 space-y-2.5">
            {TEXT_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`po-diary-${field.key}`} className="text-xs">
                  {field.label}
                </Label>
                <Input
                  id={`po-diary-${field.key}`}
                  value={draft[field.key]}
                  placeholder={field.placeholder}
                  onChange={(e) => updateDraft(field.key, e.target.value)}
                  className="h-9"
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="po-diary-orderDate" className="text-xs">
                下单日期
              </Label>
              <Input
                id="po-diary-orderDate"
                type="date"
                value={draft.orderDate}
                onChange={(e) => updateDraft('orderDate', e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="po-diary-expectedDate" className="text-xs">
                预期送达日期
              </Label>
              <Input
                id="po-diary-expectedDate"
                type="date"
                value={draft.expectedDate}
                onChange={(e) => updateDraft('expectedDate', e.target.value)}
                className="h-9"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDialogOpen(false)}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            >
              取消
            </button>
            <button
              type="button"
              data-testid="po-diary-submit"
              onClick={() => void submit()}
              disabled={saving}
              className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认：复用项目内 ConfirmDialog，避免原生 confirm 的焦点问题 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除该日记条目"
        message={
          pendingDelete
            ? `将删除整条条目（${dateSummary(pendingDelete)}）：${summarize(pendingDelete)}。删除后日历上的「下单」与「预期送达」标记会同时消失，且不可恢复。`
            : ''
        }
        confirmLabel="删除"
        cancelLabel="取消"
        variant="destructive"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}