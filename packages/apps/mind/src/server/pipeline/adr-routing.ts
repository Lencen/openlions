/**
 * adr-routing.ts — 架构决策载体路由 (2026-09-14)
 *
 * 落地任务: cmu0dtqxe0hip1j761s7y7cin  ([落地] 提案落地: [挑战] 13端接入 f-001)
 * 提案(知识): cmtwhgx8q01zs1j76w8yskwuj  (verification=PROPOSAL_ACCEPTED)
 * 被挑战 finding: FlywheelReflection cmrujl0zc00ih7vt2bc7l2zge / theme=13端接入 / f-001
 *
 * 提案的核心判断 (逐条对应):
 *   路径 A: 设计决策 = 架构契约, 标准载体是 ADR, 不是 Knowledge。
 *   路径 C: 架构 -> ADR, 运营 patterns -> Knowledge。Q1-Q6 属架构层, 不该落 Knowledge。
 *   ③ 反反驳: 即使入 ADR, Knowledge 表也应有 **1 条索引指针**(指向 ADR)方便检索。
 *   ④ 配套: ADR 模板 + "Knowledge 不存内容, 只存指针" 的索引约定。
 *
 * 本模块只做**纯判断 + 文件读取**, 不碰数据库 (落库在 execute-improving-task.ts 里做),
 * 以便单测直接 import (见 packages/apps/mind/scripts/test-f001-adr-routing.ts)。
 */

import fs from "node:fs";
import path from "node:path";
import { resolveLionsRoot } from "./lib/lions-root";

/** 与 finding 结构兼容的最小接口 (只读字段)。 */
export interface ArchFindingLike {
  id?: string;
  what?: string;
  why?: string;
  requirement?: string;
  acceptance?: string;
  relatedTopic?: string;
  evidenceSnippet?: string;
}

export interface AdrEntry {
  /** 形如 "ADR-0001" */
  id: string;
  /** 文件名, 如 "ADR-0001-service-classification.md" */
  file: string;
  title: string;
  status: string;
  /** 与 FlywheelReflection.theme 对齐的主题词 (覆盖匹配按主题隔离) */
  theme: string;
  keywords: string[];
}

/** ADR 目录 (env 可覆盖, 与 platform 其他路径解析口径一致)。 */
export const ADR_DIR = process.env.LIONS_ADR_DIR || resolveLionsRoot() + "/docs/architecture/adr";

/** Knowledge 指针行的固定来源标记 —— 守门脚本/查询按它识别 "指针, 非内容"。 */
export const ADR_INDEX_SOURCE_TYPE = "ADR_INDEX";
export const ADR_INDEX_VERIFICATION = "ADR_INDEX_POINTER";

/** 架构层主题标志词: 出现这些词说明 finding 在谈架构决策, 而非运营 pattern。 */
const ARCH_TOPIC_MARKERS =
  /设计决策|架构决策|架构契约|技术选型|服务分类|服务三档|权限模型|鉴权模型|网关位置|网关选型|多\s*agent\s*编排|编排服务|接口契约|部署拓扑|错误码标准|降级策略|健康检查|ADR/i;

/** 显式"决策/契约"口径 —— 本路由只处理这一类, 避免把普通架构类工程 finding 全部卷进来。 */
const DECISION_MARKERS = /设计决策|架构决策|架构契约|ADR/i;

/**
 * 显式"要一份架构级记录"的口径 (2026-09-14 落地任务 cmtwt83j505rq1j76gnv7ucb6,
 * 提案 cmtwdieeq00q21j76gmbwbwp7, 挑战 f-001「V3反思引擎三层管道架构未沉淀」)。
 *
 * 与"决策/契约"字样不同, 这类 finding 的诉求是"把整套架构沉淀成产物条目"——
 *   例: requirement 写 "创建 Memory(theme=V3反思引擎架构, type=ARCHITECTURE)含三层管道",
 *       或 acceptance 要 "完整架构级记录"。
 * 它没有 设计决策/架构契约 字面, 但正是本路由要拦的错位形态: 架构正文不该进 K-V。
 * 收紧: 必须同时命中 "架构级记录/完整架构/架构蓝图/架构沉淀/三层管道/type=ARCHITECTURE"
 *   与架构名词, 避免把普通工程 finding 卷进来。
 */
const ARCH_RECORD_MARKERS = /架构级记录|完整架构|架构蓝图|架构沉淀|三层管道|type\s*[:=]\s*ARCHITECTURE/i;
const ARCH_NOUN = /架构|管道|蓝图|流水线/;

/**
 * 判定一个 finding 是否属于"把架构记录落成 Memory/Knowledge 内容行"的错位形态。
 *
 * 收紧口径(实测 573 条 CREATE_KNOWLEDGE finding, 旧宽口径命中 43 条, 本口径 35 条, 且真正路由还需 ADR 覆盖):
 *   (1) 文本显式出现 设计决策 / 架构决策 / 架构契约 / ADR -> 命中(本路由的目标形态, 如 f-001);
 *   (2) acceptance 要求把"决策/架构/选型"写进 Knowledge 内容行, 且文本落在架构层标志词上;
 *   (3) (2026-09-14 新增) 显式要求"架构级记录/完整架构/三层管道/type=ARCHITECTURE" ——
 *       覆盖 CREATE_MEMORY 形态的架构沉淀诉求(f-001 V3反思引擎), 原本无 决策 字面而漏网。
 *
 * 反例(必须为 false): 运营/工程 pattern, 例如 "Knowledge表存在title包含'Naive UI'的记录" ——
 *   没有任何决策称呼, 属 Knowledge 正常职责, 不走本路由。
 */
export function isArchitectureDecisionFinding(f: ArchFindingLike): boolean {
  const all = [f.what, f.why, f.requirement, f.relatedTopic, f.evidenceSnippet, f.acceptance]
    .filter(Boolean)
    .join("\n");
  if (!all.trim()) return false;
  if (DECISION_MARKERS.test(all)) return true;
  if (ARCH_RECORD_MARKERS.test(all) && ARCH_NOUN.test(all)) return true;
  const wantsKnowledgeContent = /Knowledge\s*表|Knowledge\s*条目|知识库/.test(String(f.acceptance || ""));
  return wantsKnowledgeContent && /决策|架构|选型/.test(all) && ARCH_TOPIC_MARKERS.test(all);
}

/**
 * 读取 ADR 目录, 解析每个 ADR 的 id/title/status/keywords。
 * 目录不存在或无可解析文件 -> 返回 []（不抛错, 让调用方走"未覆盖"分支)。
 */
export function readAdrCatalog(dir: string = ADR_DIR): AdrEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^ADR-\d{4}-.+\.md$/.test(f));
  } catch {
    return [];
  }
  const out: AdrEntry[] = [];
  for (const file of files.sort()) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(dir, file), "utf-8");
    } catch {
      continue;
    }
    const id = (file.match(/^(ADR-\d{4})/) || [])[1] || file;
    const titleRaw = (raw.match(/^#\s+(.+)$/m) || [])[1] || id;
    const title = titleRaw.replace(new RegExp("^" + id + ":\\s*"), "").trim();
    const status = ((raw.match(/^\s*-\s*\*\*Status\*\*:\s*(.+)$/m) || [])[1] || "Unknown").trim();
    const theme = ((raw.match(/^\s*-\s*\*\*Theme\*\*:\s*(.+)$/m) || [])[1] || "").trim();
    const kwLine = (raw.match(/^\s*-\s*\*\*Keywords\*\*:\s*(.+)$/m) || [])[1] || "";
    const keywords = kwLine
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    out.push({ id, file, title, status, theme, keywords });
  }
  return out;
}

/**
 * finding 是否被某个 ADR 覆盖。
 * 覆盖 = **主题对齐**(ADR.Theme 含 finding 主题, 或 ADR 未声明主题视作全局) **且** finding 文本含 ADR 关键词。
 * 主题隔离是必须的: 否则 "健康检查" 这种通用关键词会把别的主题的 finding 误判成被 ADR-0006 覆盖。
 */
export function findAdrCoverage(f: ArchFindingLike, catalog: AdrEntry[], theme?: string): AdrEntry[] {
  const text = [f.what, f.why, f.requirement, f.relatedTopic, f.evidenceSnippet]
    .filter(Boolean)
    .join(" ");
  return catalog.filter((a) => {
    if (theme && a.theme && !a.theme.split(/[,，、]/).map((s) => s.trim()).includes(theme)) return false;
    return a.keywords.some((k) => k.length >= 2 && text.includes(k));
  });
}

export interface AdrIndexPointer {
  title: string;
  content: string;
  filePath: string;
}

/**
 * 生成**唯一**的 ADR 索引指针行内容。
 * 约定: 指针行只列出 ADR 路径 + 一句话标题, 不复制决策正文;
 *       Proposed 的 ADR 明确标注 "未定, 不得当结论引用"(对应提案路径 B)。
 */
export function buildAdrIndexPointer(theme: string, adrs: AdrEntry[]): AdrIndexPointer {
  const accepted = adrs.filter((a) => /^Accepted/i.test(a.status));
  const proposed = adrs.filter((a) => !/^Accepted/i.test(a.status));
  const title = `[ADR索引] ${theme} 架构设计决策主载体(Knowledge 只存指针)`;
  const lines: string[] = [
    `架构决策主载体 = ADR (docs/architecture/adr/)。本 Knowledge 行只作检索指针, 不复制决策内容。`,
    `口径: Knowledge 存判断辅助/可复用规则; 架构契约存 ADR。检索到本行 -> 去 ADR 看正文。`,
    ``,
    `已定(Accepted) ${accepted.length} 条:`,
    ...accepted.map((a) => `- ${a.id} ${a.title} -> docs/architecture/adr/${a.file}`),
  ];
  if (proposed.length) {
    lines.push(``, `未定/待补(Proposed, 不得当结论引用) ${proposed.length} 条:`);
    for (const a of proposed) lines.push(`- ${a.id} ${a.title} -> docs/architecture/adr/${a.file}`);
  }
  return { title, content: lines.join("\n"), filePath: "docs/architecture/adr" };
}

/** 指针行标题的稳定形式(供幂等查询/守门用)。 */
export function adrIndexPointerTitle(theme: string): string {
  return `[ADR索引] ${theme} 架构设计决策主载体(Knowledge 只存指针)`;
}

/** 执行器要做的动作 —— 把决策从 DB 写入里拆出来, 便于单测覆盖真实 f-001。 */
export type AdrRoutingDecision =
  | { action: "NOT_ARCH" }
  | { action: "POINTER"; pointer: AdrIndexPointer; covered: AdrEntry[] }
  | { action: "STRICT_SKIP"; catalogSize: number }
  | { action: "FALLBACK"; catalogSize: number };

/**
 * 架构决策载体路由决策(纯函数, 不碰 DB):
 *   NOT_ARCH      —— 非架构决策类 finding, 不干预(走既有 Knowledge 内容行路径);
 *   POINTER       —— 命中 ADR 覆盖, 落 1 条指针行(不落内容行);
 *   STRICT_SKIP   —— strict 模式且无 ADR 覆盖: 拒绝落 Knowledge, 迫使先补 ADR;
 *   FALLBACK      —— soft 模式且无 ADR 覆盖: 回落既有内容行路径(不改存量行为)。
 */
export function routeArchitectureDecision(
  f: ArchFindingLike,
  catalog: AdrEntry[],
  theme: string,
  strict: boolean
): AdrRoutingDecision {
  if (!isArchitectureDecisionFinding(f)) return { action: "NOT_ARCH" };
  const covered = findAdrCoverage(f, catalog, theme);
  if (covered.length === 0) {
    return strict ? { action: "STRICT_SKIP", catalogSize: catalog.length } : { action: "FALLBACK", catalogSize: catalog.length };
  }
  return { action: "POINTER", pointer: buildAdrIndexPointer(theme, covered), covered };
}
