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

/**
 * 日历标记类型。
 * - `order` / `delivery`：可写日记条目，同一条目在下单日与预期送达日各占一格；
 * - `onboarding`：★V6 板块四派生的**只读**入职事件，不进任何写链路（不可编辑、不可删除）。
 */
export type PoDiaryMarkerKind = 'order' | 'delivery' | 'onboarding';

/** 日历某一格上的一个标记。 */
export interface PoDiaryMarker {
  entry: PoDiaryEntry;
  kind: PoDiaryMarkerKind;
}

/** 标记类型的中文展示文案（日历格与明细共用）。 */
export const MARKER_LABEL: Record<PoDiaryMarkerKind, string> = {
  order: '下单',
  delivery: '预期送达',
  onboarding: '入职',
};

/* ==================== V6 板块四 · 只读入职事件 ==================== */

/**
 * 日历上的一条只读入职事件（由 `履约跟踪.json` 主表一行派生）。
 *
 * ★读写隔离：本类型**绝不**进入 `PoDiaryDoc.entries`，也不参与 `serializeDiary()` / `persist()`，
 *   它只作为渲染入参（`externalEvents`）传入日历，因此新增/删除日记不会影响它，反之亦然。
 * ★前端零聚合：留存率直接取主表字段，前端不重算、不跨行加权；
 *   留存率随批次固定，不随任何筛选变化。
 */
export interface OnboardingEvent {
  /** 事件唯一标识（入职日期|仓|供应商），用作 React key。 */
  id: string;
  /** 本地日历格键 `YYYY-MM-DD`。 */
  dateKey: string;
  物流仓: string;
  供应商: string;
  入职总人数: number;
  '30天留存人数': number;
  '90天留存人数': number;
  /** 直取主表值；窗口未满时按 `追踪中30/90` 标记改为「追踪中」展示，不清零。 */
  '30天留存率': number | null;
  '90天留存率': number | null;
  /** 内联明细串：`工种×班次×性质×技能=人数 ; …`。 */
  明细: string;
  /** 入职日 + 30 天 > 今天 → 窗口未满，留存率尚不可判读。 */
  追踪中30: boolean;
  /** 入职日 + 90 天 > 今天 → 窗口未满。 */
  追踪中90: boolean;
}

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

/** 履约追踪（V6 板块四）派生产物路径，只读；由 `pnpm gen:v6` 与主进程预置共同保证存在。 */
export const PO_FULFILLMENT_FILE_PATH = '~/.openclaw/workspace-po/履约追踪.json';

/** 产物里入职日期是 `2024-05-01T00:00:00.000` 形式，日历只要本地日期部分。 */
function toOnboardingDateKey(value: unknown): string {
  const text = toText(value).slice(0, 10);
  return isValidDateKey(text) ? text : '';
}

/** 数值字段容错：非有限数一律回退 fallback，绝不让整块看板因脏数据白屏。 */
function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 比率字段容错：null 是合法业务值（口径未定义），非法值同样归一成 null。 */
function toRatioOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 把板块四主表解析成只读入职事件。
 *
 * - 日期非法或缺失的行直接丢弃（无法落到日历格，且台账段落已下线，留着也无处展示）；
 * - `追踪中30/90` 以 `today` 为基准判定：入职日 + N 天 > 今天 即窗口未满，
 *   此时主表给出的留存率是「截至今天尚未到期」的乐观值，不可直接判读；
 * - 传入 `today` 而非在函数内取 `new Date()`，是为了让该纯函数可测、结果可复现。
 */
export function parseOnboardingEvents(text: string, today: Date): OnboardingEvent[] {
  try {
    const doc = JSON.parse(text) as { 主表?: unknown };
    if (!doc || !Array.isArray(doc.主表)) return [];
    const 今日零点 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const 一天 = 24 * 60 * 60 * 1000;
    const events: OnboardingEvent[] = [];
    for (const raw of doc.主表 as Record<string, unknown>[]) {
      if (!raw || typeof raw !== 'object') continue;
      const dateKey = toOnboardingDateKey(raw.入职日期);
      if (!dateKey) continue;
      const [y, m, d] = dateKey.split('-').map(Number);
      const 入职时刻 = new Date(y, m - 1, d).getTime();
      const 物流仓 = toText(raw.物流仓) || '未知';
      const 供应商 = toText(raw.供应商) || '未知';
      events.push({
        id: `${dateKey}|${物流仓}|${供应商}`,
        dateKey,
        物流仓,
        供应商,
        入职总人数: toFiniteNumber(raw.入职总人数, 0),
        '30天留存人数': toFiniteNumber(raw['30天留存人数'], 0),
        '90天留存人数': toFiniteNumber(raw['90天留存人数'], 0),
        '30天留存率': toRatioOrNull(raw['30天留存率']),
        '90天留存率': toRatioOrNull(raw['90天留存率']),
        明细: toText(raw.明细),
        追踪中30: 入职时刻 + 30 * 一天 > 今日零点,
        追踪中90: 入职时刻 + 90 * 一天 > 今日零点,
      });
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * 把入职事件展开成「日期 → 事件列表」。
 *
 * 独立于 `groupMarkersByDate()` 存在，而不是并进同一个 Map —— 这是读写隔离的结构保证：
 * 可写日记与只读派生事件在数据结构层面就不共用容器，渲染时才并列显示。
 * 同日多条按人数降序，让采购一眼看到当天的主要来源。
 */
export function groupOnboardingByDate(events: OnboardingEvent[]): Map<string, OnboardingEvent[]> {
  const map = new Map<string, OnboardingEvent[]>();
  for (const e of events) {
    const bucket = map.get(e.dateKey);
    if (bucket) bucket.push(e);
    else map.set(e.dateKey, [e]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => b.入职总人数 - a.入职总人数);
  }
  return map;
}