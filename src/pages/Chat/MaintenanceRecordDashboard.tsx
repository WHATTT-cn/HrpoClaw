/**
 * 历史维修记录看板
 *
 * 仅在 FDE agent 对话窗口左半区渲染（见 Chat/index.tsx）。
 * 数据来源：`~/.openclaw/workspace-fde/维修记录.json`（由 agent-config 预置 5 条种子，
 * maintenance-records 插件的 record_maintenance 工具经人审后追加新记录）。
 *
 * 结构：
 * - 顶部标题 + 刷新按钮：手动重新读取 JSON 文件（登记新记录后可刷新看板）。
 * - 每条维修记录用统一圆角矩形卡片分块展示：工单号 + 日期做标题，
 *   已确认原因 / 已执行维修 / 复机验证三要素分行。
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Wrench } from 'lucide-react';
import { readTextFile } from '@/lib/file-preview-client';

/** 与 maintenance-records 插件 MaintenanceRecord 契约对齐的单条记录。 */
interface MaintenanceRecord {
  workOrder: string;
  date: string;
  confirmedCause: string;
  repairAction: string;
  verification: string;
}

/** 维修记录 JSON 文件根结构。 */
interface MaintenanceRecordsDoc {
  records: MaintenanceRecord[];
}

/** 与 agent-config / 插件 resolveMaintenancePath 一致的固定路径。 */
const MAINTENANCE_FILE_PATH = '~/.openclaw/workspace-fde/维修记录.json';

/** 容错解析：非法/缺失结构一律回退空列表，绝不抛错阻断看板渲染。 */
function parseRecords(raw: string): MaintenanceRecord[] {
  try {
    const parsed = JSON.parse(raw) as Partial<MaintenanceRecordsDoc> | null;
    if (!parsed || !Array.isArray(parsed.records)) {
      return [];
    }
    return parsed.records.filter(
      (r): r is MaintenanceRecord =>
        !!r && typeof r.workOrder === 'string' && typeof r.confirmedCause === 'string',
    );
  } catch {
    return [];
  }
}

/** 单要素块（label + 文本），统一渲染样式。 */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm leading-relaxed text-foreground">{value || '—'}</span>
    </div>
 );
}

/** 单条维修记录块：统一圆角矩形风格。 */
function RecordCard({ record }: { record: MaintenanceRecord }) {
  return (
    <div className="rounded-xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.02]">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
          {record.workOrder}
        </span>
        <span className="text-xs text-muted-foreground">{record.date || '日期未填写'}</span>
      </div>
      <div className="space-y-2">
        <Field label="已确认原因" value={record.confirmedCause} />
        <Field label="已执行维修" value={record.repairAction} />
        <Field label="复机验证" value={record.verification} />
      </div>
    </div>
  );
}

export function MaintenanceRecordDashboard() {
  const [records, setRecords] = useState<MaintenanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await readTextFile(MAINTENANCE_FILE_PATH);
      if (!result.ok || typeof result.content !== 'string') {
        // 文件尚未生成（首次启动种子未落盘）时视为空列表，不报错。
        setRecords([]);
        return;
      }
      setRecords(parseRecords(result.content));
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取维修记录失败');
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部：标题 + 刷新 */}
      <div className="shrink-0 border-b border-black/5 px-4 py-3 dark:border-white/5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Wrench className="h-3.5 w-3.5" />
            历史维修记录看板
          </h2>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-black/10 bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
          >
            <RefreshCw className={loading ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
            刷新
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          共 {records.length} 条记录 · APX-240 自动封装设备
        </p>
      </div>

      {/* 主体：维修记录卡片列表 */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {!error && records.length === 0 && !loading && (
          <p className="px-1 text-xs text-muted-foreground">暂无历史维修记录。</p>
        )}
        {records.map((record, idx) => (
          <RecordCard key={`${record.workOrder}-${idx}`} record={record} />
        ))}
      </div>
    </div>
  );
}

export default MaintenanceRecordDashboard;