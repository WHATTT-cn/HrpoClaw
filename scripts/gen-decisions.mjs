// TS 唯一真源 -> shared 预置快照 + 工作区 JSON；禁止合并旧记录。
// pnpm gen:decisions [workspaceJsonPath] [sharedJsonPath]
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sourcePath = resolve(root, 'src/data/supplier-decision-table.ts');

export function serializeDecisions(doc) {
  if (!doc || !Array.isArray(doc.records)) throw new Error('records must be an array');
  const fields = ['decisionNo', 'date', 'warehouse', 'supplier', 'headcount', 'basis'];
  const ids = new Set();
  const records = doc.records.map((record) => {
    if (!record || fields.some((key) => typeof record[key] !== 'string' || !record[key].trim())) {
      throw new Error('Each record must contain six non-empty string fields');
    }
    if (ids.has(record.decisionNo)) throw new Error(`Duplicate decisionNo: ${record.decisionNo}`);
    ids.add(record.decisionNo);
    return Object.fromEntries(fields.map((key) => [key, record[key]]));
  });
  return `${JSON.stringify({ records }, null, 2)}\n`;
}

export async function loadDecisions() {
  // 使用 TypeScript 编译器而非正则提取，保留转义字符、中文及合法 TS 语法。
  const source = await readFile(sourcePath, 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  if (result.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) {
    throw new Error('Invalid TypeScript decision source');
  }
  const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputText).toString('base64')}`);
  return mod.supplierDecisions;
}

export async function generateDecisions(workspacePath, sharedPath, doc) {
  const content = serializeDecisions(doc ?? await loadDecisions());
  // 完整校验后才写入；每份文件先写同目录临时文件再替换，避免读到半截 JSON。
  for (const target of new Set([resolve(sharedPath), resolve(workspacePath)])) {
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, target);
  }
  return content;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const workspace = resolve(process.argv[2] ?? resolve(homedir(), '.openclaw/workspace-po/用工决策.json'));
  const shared = resolve(process.argv[3] ?? resolve(root, 'shared/po-supplier-decisions.json'));
  const content = await generateDecisions(workspace, shared);
  console.log(`Generated ${JSON.parse(content).records.length} records (full replacement):`);
  console.log(workspace);
  console.log(shared);
}