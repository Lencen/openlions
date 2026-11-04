/**
 * memory-claim-verify.ts — Memory「完成/验证类断言」的无证据校验机制(只读, 不修订数据)
 *   (2026-09-15 机制修复: 由待办升级任务 cmu261cbk08alki4ab3ucfw5p / finding f-003 Pipeline Memory[mt57s0])
 *
 * 为什么存在(根因, 实测):
 *   Memory[cmtn6csj802cp2rfmgjmt57s0](简称 mt57s0) 回填了一条「v10-Phase1端到端链路已验证」的**完成断言**,
 *   tier=HOT、未标项目归属、无验证证据链接。该断言与 LIONS 飞轮实测直接冲突, 却被当成"健康背书"反复误导
 *   后续 session; 反思 3 次标 RECURRING 仍复发。人工决策(system:auto-decision-8d @ 2026-09-14T21:01Z)
 *   判定: **数据完整性风险不允许自动修订**, 需 quarantine + memory 校验机制 —— 本模块提供后者。
 *
 * 做什么(机制, 不是一次性特判):
 *   - detectVerificationClaim(): 从一条 Memory 的标题/正文里抽出「完成/验证类绝对断言」的**原句与命中短语**
 *     (精度优先: 排除否定/要求/待办/方法类表述, 避免把"验证要求/待验证"也当断言)。
 *   - verifyMemoryClaims(): 对每条断言给出三态判定:
 *       SUPERSEDED        —— 该行已被取代(quarantine 生效), 不再是活性健康背书;
 *       SUPPORTED         —— 断言带**证据锚点**(linkedTo/filePath/sql/commit/文件路径);
 *       UNSUPPORTED_CLAIM —— 活性 + 无证据锚点的完成断言 -> 需要裁决(本模块只报不改)。
 *   **本模块绝不写库**。是否 quarantine 由既有 supersededBy 机制 + 裁决方决定(与人工决策一致)。
 *
 * 诚实边界:
 *   - 是**精度优先的启发式**, 不是完备证明: 漏报(更委婉的断言)与误报(把叙述当断言)都可能存在;
 *     输出始终带命中原句, 供人复核, 不据此自动改数据。
 *   - 不覆盖 Knowledge/Practice/Reflection; 只针对 Memory(本次冲突发生在 Memory)。
 *   - 不负责产生 finding; 调用方可把它接进 findings 生成/复核流程。
 */

export interface MemoryClaimRow {
  id: string;
  title?: string | null;
  content: string;
  tier?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  linkedTo?: string | null;
  filePath?: string | null;
  supersededBy?: string | null;
  theme?: string | null;
  createdAt?: number | null;
}

export interface VerificationClaim {
  /** 命中的断言短语, 如 "验证通过"/"已验证" */
  phrase: string;
  /** 命中短语所在的原句(供人复核, 不截断到看不出上下文) */
  sentence: string;
  /** 是否针对"系统/链路/飞轮"这类整体健康(而非局部小事) */
  systemHealth: boolean;
  /** 抽取到的项目/范围线索(有则降低"跨项目误用"风险) */
  scopeHint: string | null;
}

export interface MemoryClaimVerdict extends VerificationClaim {
  memoryId: string;
  status: "SUPERSEDED" | "SUPPORTED" | "UNSUPPORTED_CLAIM";
  evidenceAnchor: string | null;
  reason: string;
}

/** 完成/验证类断言: 主语限系统级名词, 后接"通过/成功/完成验证"等。 */
const CLAIM_PATTERNS: RegExp[] = [
  // 系统级主语 + 验证类谓语(谓语按"最长优先"排序, 避免 '已验证' 抢先截断 '已验证通过')
  /(?:全链路|端到端|链路|流水线|pipeline|飞轮|系统|服务|接口|功能|部署|方案|架构|改造|修复)[^。；;，,\n]{0,14}?(?:已验证通过|验证通过|验证成功|已通过|全部通过|通过了?验证|验证完毕|全部验证|已验证)/i,
  // 直接断言"已验证通过/全部验证通过"(不限主语, 但受否定/要求守卫约束)
  /(?:已验证通过|全部验证通过|端到端验证通过)/,
];

/** 否定/未完成/要求类守卫: 命中短语(或其前文)出现这些 -> 不是"完成断言"。 */
const GUARD = /(未|尚未|无法|不能|没有|是否|能否|需要|需|待|要求|标准|方法|流程|习惯|偏好|策略|计划|计划中|准备|打算|目标)/;

/** 证据锚点: 可独立复算/可追溯的引用, 而非断言本身。 */
const EVIDENCE_ANCHOR = /(sql:|commit\s+[0-9a-f]{7,}|probe-[a-z0-9-]+|memory-report|[a-z0-9_./-]+\.(?:cjs|mjs|ts|tsx|json|jsonl|log|db|md)\b)/i;

const SCOPE_HINT = /(pipeline-v10|pipeline-v\d+|pipeline_config|pipeline[-_][a-z0-9_]+|LIONS|Hermes|hermes|飞轮|\bv\d+\b|独立项目|项目[:：]?\s*[^\s，,。]{1,20})/i;

function splitSentences(text: string): string[] {
  return String(text || "")
    .split(/[。！!\n；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从一条 Memory 抽取完成/验证类断言(精度优先)。 */
export function detectVerificationClaims(row: Pick<MemoryClaimRow, "title" | "content">): VerificationClaim[] {
  const out: VerificationClaim[] = [];
  const sentences = [...splitSentences(String(row.title || "")), ...splitSentences(String(row.content || ""))];
  for (const s of sentences) {
    for (const re of CLAIM_PATTERNS) {
      const m = s.match(re);
      if (!m) continue;
      const phrase = m[0];
      // 守卫: 命中短语本身或其前文出现否定/要求词 -> 不是"完成断言"。
      //   例: "链路尚未验证通过" 的 '尚未' 在短语内; "尚未确认全链路验证通过" 的 '尚未' 在短语前。
      const head = s.slice(0, m.index ?? 0);
      if (GUARD.test(phrase) || GUARD.test(head)) continue;
      if (out.some((c) => c.sentence === s)) break;
      out.push({
        phrase,
        sentence: s.length > 220 ? s.slice(0, 220) + "…" : s,
        systemHealth: /(全链路|端到端|链路|流水线|pipeline|飞轮|系统|服务|架构|部署)/i.test(phrase),
        scopeHint: (s.match(SCOPE_HINT) || [null])[0],
      });
      break;
    }
  }
  return out;
}

/** 断言是否带证据锚点(linkedTo/filePath 或正文里可追溯的 sql/commit/文件/探针)。 */
export function evidenceAnchorOf(row: MemoryClaimRow, sentence: string): string | null {
  if (row.linkedTo && String(row.linkedTo).trim()) return `linkedTo=${row.linkedTo}`;
  if (row.filePath && String(row.filePath).trim()) return `filePath=${row.filePath}`;
  const m = String(sentence || "").match(EVIDENCE_ANCHOR);
  if (m) return `content:${m[0]}`;
  const m2 = String(row.content || "").match(EVIDENCE_ANCHOR);
  if (m2) return `content:${m2[0]}`;
  return null;
}

/** 对一批 Memory 逐条断言给出三态判定(只读)。 */
export function verifyMemoryClaims(rows: MemoryClaimRow[]): MemoryClaimVerdict[] {
  const out: MemoryClaimVerdict[] = [];
  for (const row of rows || []) {
    for (const c of detectVerificationClaims(row)) {
      const evidenceAnchor = evidenceAnchorOf(row, c.sentence);
      const superseded = !!(row.supersededBy && String(row.supersededBy).trim());
      let status: MemoryClaimVerdict["status"];
      let reason: string;
      if (superseded) {
        status = "SUPERSEDED";
        reason = `已被 ${row.supersededBy} 取代(quarantine 生效), 不再是活性背书`;
      } else if (evidenceAnchor) {
        status = "SUPPORTED";
        reason = `断言带证据锚点: ${evidenceAnchor}`;
      } else {
        status = "UNSUPPORTED_CLAIM";
        reason = "活性 Memory 的完成断言, 但无 linkedTo/filePath/sql/commit/探针等可追溯证据锚点";
      }
      out.push({ memoryId: row.id, ...c, status, evidenceAnchor, reason });
    }
  }
  return out;
}

export interface MemoryClaimSummary {
  scanned: number;
  claims: number;
  byStatus: Record<string, number>;
  systemHealthUnsupported: number;
}

export function summarizeMemoryClaims(verdicts: MemoryClaimVerdict[], scanned: number): MemoryClaimSummary {
  const byStatus: Record<string, number> = { SUPERSEDED: 0, SUPPORTED: 0, UNSUPPORTED_CLAIM: 0 };
  let systemHealthUnsupported = 0;
  for (const v of verdicts) {
    byStatus[v.status] = (byStatus[v.status] || 0) + 1;
    if (v.status === "UNSUPPORTED_CLAIM" && v.systemHealth) systemHealthUnsupported++;
  }
  return { scanned, claims: verdicts.length, byStatus, systemHealthUnsupported };
}
