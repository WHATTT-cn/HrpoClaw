/**
 * 用工决策看板（可写）
 *
 * 仅在 PO agent 对话窗口渲染（见 Chat/index.tsx），与 SupplierPortraitDashboard 并列为一个 Tab。
 * 数据来源：`~/.openclaw/workspace-po/用工决策.json`（由 po-decisions 插件在人审通过后写入）。
 *
 * 结构：
 * - 顶部标题 + 刷新按钮：手动重新读取 JSON 文件。
 * - 主体：按决策记录逐条渲染为圆角卡片，展示单号/日期/仓/供应商/人数/依据。
 * - 空态：文件不存在或无记录时给出提示。
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ClipboardList } from 'lucide-react';
import { readTextFile } from '@/lib/file-preview-client';

/** 决策看板数据文件路径（与插件落库、agent-config 种子路径一致）。 */
const DECISION_FILE_PATH = '~/.openclaw/workspace-po/用工决策.json';

/** 单条用工决策记录，字段与 po-decisions 插件落库结构严格对齐。 */
interface DecisionRecord {
  decisionNo: string;
  date: string;
  warehouse: string;
  supplier: string;
  headcount: string;
  basis: string;
}

interface DecisionsDoc {
  records: DecisionRecord[];
}

/** 容错解析 JSON 文本为记录数组，任何异常都回退空数组。 */
function parseRecords(text: string): DecisionRecord[] {
  try {
    const doc = JSON.parse(text) as DecisionsDoc;
    if (!doc || !Array.isArray(doc.records)) {
      return [];
    }
    return doc.records.filter(
      (r): r is DecisionRecord =>
        !!r && typeof r.decisionNo === 'string' && typeof r.warehouse === 'string',
    );
  } catch {
    return [];
  }
}

/** 单条指标（label + 值）。 */
function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/** 单条决策记录卡片。 */
function RecordCard({ record }: { record: DecisionRecord }) {
  return (
    <div className="rounded-xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.02]">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
          {record.decisionNo}
        </span>
        <span className="text-xs text-muted-foreground">{record.date}</span>
      </div>
      <div className="mb-2 grid grid-cols-3 gap-x-3 gap-y-2">
        <Field label="物流仓" value={record.warehouse} />
        <Field label="供应商" value={record.supplier} />
        <Field label="承接人数" value={record.headcount} />
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">决策依据</span>
        <span className="text-sm text-foreground/90">{record.basis}</span>
      </div>
    </div>
  );
}

export function SupplierDecisionDashboard() {
  const [records, setRecords] = useState<DecisionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await readTextFile(DECISION_FILE_PATH);
      if (!res.ok) {
        // 文件不存在等同于空看板，不作为错误展示。
        if (res.error === 'notFound') {
          setRecords([]);
        } else {
          setError(`读取失败：${res.error ?? '未知错误'}`);
          setRecords([]);
        }
        return;
      }
      setRecords(parseRecords(res.content ?? ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      <div className="flex shrink-0 items-center justify-between border-b border-black/5 px-4 py-3 dark:border-white/5">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          用工决策看板
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </button>
      </div>

      {/* 主体：决策记录列表 */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {!error && records.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
            <ClipboardList className="h-8 w-8 opacity-40" />
            <p className="text-sm">暂无用工决策记录</p>
            <p className="text-[11px]">在对话中确认分单决策后，经人审通过即会写入此看板。</p>
          </div>
        )}
        {records.map((record) => (
          <RecordCard key={record.decisionNo} record={record} />
        ))}
      </div>
    </div>
  );
}

export default SupplierDecisionDashboard;