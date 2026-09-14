/**
 * PO 日记（履约追踪看板顶部日历板块）的数据契约与纯函数工具。
 *
 * 与「用工决策」的关键差异：
 * - 用工决策.json 是 TS 真源经 `pnpm gen:decisions` 派生的**只读产物**；
 * - PO日记.json 是用户在界面上直接录入的**可写运行时数据**，没有 TS 真源、没有生成脚本，
 *   唯一写入方是本看板的新增/删除操作（经 host-api files.writeText 落盘）。
 *
 * 落盘位置：`~/.openclaw/workspace-po/PO日记.json`（在 files-api 的写沙箱 `~/.openclaw` 内）。
 * 该文件由 electron/utils/agent-config.ts 的 ensurePresetPoDiaryFile() 幂等预置为空文档，
 * 因为 host-api 的 writeText 不会创建新文件（stat 失败即返回 notFound）。
 *
 * 日历标记模型：一条条目最多在日历上出现两次 —— 下单日期那格标「下单」、
 * 预期送达日期那格标「预期送达」；两个日期都为空则归入「未排期」。
 */

/** PO 日记看板数据文件路径（前端读写与主进程预置共用同一约定）。 */
export const PO_DIARY_FILE_PATH = '~/.openclaw/workspace-po/PO日记.json';

/**
 * 单条 PO 日记条目。
 *
 * 除 `id` 外所有业务字段均非必填（允许空字符串），由用户按掌握到的信息逐步补全。
 * `orderDate` 与 `expectedDate` 都为空时条目无法落到日历，会被归入「未排期」分组。
 */
export interface PoDiaryEntry {
  /** 条目唯一标识，新增时本地生成，用作 React key 与删除操作的锚点。 */
  id: string;
  /** 物流仓。 */
  warehouse: string;
  /** 供应商。 */
  supplier: string;
  /** 下单种类（自由文本）。 */
  orderType: string;
  /** 预期送达人数（自由文本，允许带单位，如「12人」）。 */
  expectedHeadcount: string;
  /** 下单日期，`YYYY-MM-DD`；为空表示未记录。 */
  orderDate: string;
  /** 预期送达日期，`YYYY-MM-DD`；为空表示未记录。 */
  expectedDate: string;
  /** 创建时间（ISO 字符串），用于同一天内的稳定排序。 */
  createdAt: string;
}

/** PO 日记文档结构（与落盘 JSON 一一对应）。 */
export interface PoDiaryDoc {
  entries: PoDiaryEntry[];
}

/** 条目业务字段（不含 id/createdAt），新增表单的输入模型。 */
export type PoDiaryDraft = Omit<PoDiaryEntry, 'id' | 'createdAt'>;

/** 日历标记类型：同一条目在下单日与预期送达日各占一格。 */
export type PoDiaryMarkerKind = 'order' | 'delivery';

/** 日历某一格上的一个标记。 */
export interface PoDiaryMarker {
  entry: PoDiaryEntry;
  kind: PoDiaryMarkerKind;
}

/** 标记类型的中文展示文案（日历格与明细共用）。 */
export const MARKER_LABEL: Record<PoDiaryMarkerKind, string> = {
  order: '下单',
  delivery: '预期送达',
};

/** 空白草稿，供表单初始化与重置共用。 */
export function createEmptyDraft(orderDate = ''): PoDiaryDraft {
  return {
    warehouse: '',
    supplier: '',
    orderType: '',
    expectedHeadcount: '',
    orderDate,
    expectedDate: '',
  };
}

/** 把任意输入安全地转成 trim 过的字符串，非字符串一律回退空串。 */
function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 校验 `YYYY-MM-DD` 形式且为真实存在的日期（排除 2026-02-31 之类）。 */
export function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** 非法或空日期统一归一成空串，避免污染日历分组。 */
function normalizeDate(value: unknown): string {
  const text = toText(value);
  return isValidDateKey(text) ? text : '';
}

/**
 * 容错解析 JSON 文本为条目数组。
 *
 * 任何异常（非法 JSON、结构不符、字段类型错误）都降级处理而非抛出：
 * 日记是用户数据，宁可少显示一条也不能让整个看板白屏。
 * 早期版本写入的 `stage` 字段已废弃，解析时直接忽略。
 */
export function parseDiaryEntries(text: string): PoDiaryEntry[] {
  try {
    const doc = JSON.parse(text) as PoDiaryDoc;
    if (!doc || !Array.isArray(doc.entries)) return [];
    return doc.entries
      .filter((e): e is PoDiaryEntry => !!e && typeof e === 'object')
      .map((e) => ({
        id: toText(e.id) || createEntryId(),
        warehouse: toText(e.warehouse),
        supplier: toText(e.supplier),
        orderType: toText(e.orderType),
        expectedHeadcount: toText(e.expectedHeadcount),
        orderDate: normalizeDate(e.orderDate),
        expectedDate: normalizeDate(e.expectedDate),
        createdAt: toText(e.createdAt),
      }));
  } catch {
    return [];
  }
}

/** 固定字段顺序序列化，保证多次写入的 diff 稳定、便于人工查看。 */
export function serializeDiary(entries: PoDiaryEntry[]): string {
  const doc: PoDiaryDoc = {
    entries: entries.map((e) => ({
      id: e.id,
      warehouse: e.warehouse,
      supplier: e.supplier,
      orderType: e.orderType,
      expectedHeadcount: e.expectedHeadcount,
      orderDate: e.orderDate,
      expectedDate: e.expectedDate,
      createdAt: e.createdAt,
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 生成条目 id：时间戳 + 随机后缀，避免同一毫秒内连续新增碰撞。 */
export function createEntryId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `diary-${Date.now().toString(36)}-${rand}`;
}

/**
 * 把条目展开成「日期 → 标记列表」。
 *
 * 同一条目若两个日期都填了，会在两格各出现一次；同一天同时是下单日与预期送达日时，
 * 该格会有两个标记。两个日期都为空的条目不进入该 Map（由 unscheduled 单列）。
 */
export function groupMarkersByDate(entries: PoDiaryEntry[]): Map<string, PoDiaryMarker[]> {
  const map = new Map<string, PoDiaryMarker[]>();
  const push = (date: string, marker: PoDiaryMarker) => {
    if (!date) return;
    const bucket = map.get(date);
    if (bucket) bucket.push(marker);
    else map.set(date, [marker]);
  };
  for (const entry of entries) {
    push(entry.orderDate, { entry, kind: 'order' });
    push(entry.expectedDate, { entry, kind: 'delivery' });
  }
  return map;
}

/** 本地时区下把 Date 转成 `YYYY-MM-DD`（不能用 toISOString，那是 UTC 会跨日）。 */
export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}