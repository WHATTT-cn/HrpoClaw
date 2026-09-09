/**
 * 执行记录台账看板
 *
 * 仅在 Assistant agent 对话窗口左半区渲染（见 Chat/index.tsx）。
 * 数据来源：`~/.openclaw/workspace-assistant/执行记录.json`（由 agent-config 预置空数组种子，
 * task-ledger 插件的 record_task_step 工具在 before_tool_call 落库后追加新记录）。
 *
 * 结构：
 * - 顶部标题 + 刷新按钮：手动重新读取 JSON 文件（登记新记录后可刷新看板）。
 * - 记录按 taskId 分组，同组内按 stepNo 顺序展示每一步。
 * - status 颜色：success 绿 / blocked·failed 红 / rolled-back 黄；riskLevel:high 标红点。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ListChecks } from 'lucide-react';
import { readTextFile } from '@/lib/file-preview-client';

/** 与 task-ledger 插件 TaskStepRecord 契约对齐的单条执行记录（字段名禁改）。 */
interface TaskStepRecord {
  taskId: string;
  stepNo: number;
  action: string;
  targetApp: string;
  verify: string;
  status: string;
  riskLevel: string;
  instruction?: string;
  timestamp?: string;
  detail?: string;
}

/** 与 agent-config / 插件 resolveLedgerPath 一致的固定路径。 */
const LEDGER_FILE_PATH = '~/.openclaw/workspace-assistant/执行记录.json';

/** 容错解析：执行记录.json 根结构是直接数组；非法/缺失一律回退空列表。 */
function parseRecords(raw: string): TaskStepRecord[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
return [];
    }
    return parsed.filter(
  (r): r is TaskStepRecord =>
        !!r &&
        typeof (r as TaskStepRecord).taskId === 'string' &&
     typeof (r as TaskStepRecord).action === 'string',
    );
  } catch {
    return [];
  }
}

/** status → 徽标配色。 */
function statusClass(status: string): string {
  switch (status) {
    case 'success':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'blocked':
    case 'failed':
      return 'bg-red-500/10 text-red-600 dark:text-red-400';
    case 'rolled-back':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    default:
      return 'bg-black/5 text-muted-foreground dark:bg-white/10';
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

/** 单步执行记录块。 */
function StepCard({ record }: { record: TaskStepRecord }) {
  return (
    <div className="rounded-xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.02]">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
          步骤 {record.stepNo}
   </span>
        <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${statusClass(record.status)}`}>
          {record.status || '未知'}
</span>
  {record.riskLevel === 'high' && (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-600 dark:text-red-400">
       <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      高风险
          </span>
        )}
        {record.timestamp && (
   <span className="ml-auto text-[11px] text-muted-foreground">{record.timestamp}</span>
        )}
      </div>
      <div className="space-y-2">
        <Field label="操作" value={record.action} />
        <Field label="目标软件" value={record.targetApp} />
        <Field label="验收" value={record.verify} />
  {record.detail && <Field label="备注" value={record.detail} />}
      </div>
    </div>
  );
}

export function TaskLedgerDashboard() {
const [records, setRecords] = useState<TaskStepRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await readTextFile(LEDGER_FILE_PATH);
      if (!result.ok || typeof result.content !== 'string') {
        // 文件尚未生成（首次启动种子未落盘）时视为空列表，不报错。
     setRecords([]);
        return;
      }
      setRecords(parseRecords(result.content));
    } catch (e) {
   setError(e instanceof Error ? e.message : '读取执行记录失败');
      setRecords([]);
  } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 按 taskId 分组，组内按 stepNo 升序。 */
  const groups = useMemo(() => {
    const map = new Map<string, TaskStepRecord[]>();
    for (const r of records) {
      const list = map.get(r.taskId) ?? [];
      list.push(r);
      map.set(r.taskId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.stepNo ?? 0) - (b.stepNo ?? 0));
    }
    return Array.from(map.entries());
  }, [records]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部：标题 + 刷新 */}
      <div className="shrink-0 border-b border-black/5 px-4 py-3 dark:border-white/5">
        <div className="flex items-center justify-between">
 <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <ListChecks className="h-3.5 w-3.5" />
            执行记录台账看板
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
          共 {records.length} 条记录 · {groups.length} 个任务 · 桌面助手一句话代办
        </p>
      </div>

      {/* 主体：按任务分组的执行记录 */}
  <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {error && (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {!error && records.length === 0 && !loading && (
          <p className="px-1 text-xs text-muted-foreground">暂无执行记录。</p>
        )}
        {groups.map(([taskId, steps]) => (
      <div key={taskId} className="space-y-2">
<div className="flex items-center gap-2 px-1">
              <span className="text-xs font-semibold text-foreground">任务 {taskId}</span>
    <span className="text-[11px] text-muted-foreground">{steps.length} 步</span>
         </div>
   {steps.map((record, idx) => (
      <StepCard key={`${taskId}-${record.stepNo}-${idx}`} record={record} />
            ))}
      </div>
        ))}
      </div>
    </div>
  );
}

export default TaskLedgerDashboard;