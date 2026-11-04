/**
 * 证据判据模块 (2026-09-11 从 reconcile-findings.ts 抽出, 供单元测试与多处复用)
 *
 * 背景: 判据原先内联在批量脚本里, 只能靠"跑一遍真实数据"才知道后果 —— 2026-09-11
 * 因此发生两起事故: (1) 硬拦是否触发无法证明; (2) 批量恢复脚本匹配范围过宽, 误改 45 条
 * finding 并写入未实际执行的证据引用. 抽成纯函数后可先写用例再改逻辑.
 *
 * 判据: 证据必须可复现, 三选一 ——
 *   code   : commit 短哈希(7-40位) + 文件路径(.ts/.tsx/.js/.cjs/.py/.md/.sql[:行号])
 *   data   : 请求/SQL 片段(select/get /post //api/) + 结果(-> 或 => 或 = 后 >=30 字符)
 *   metric : before -> after 数值对
 * 不合格者不得置 RESOLVED.
 */

export type EvidenceKind = "code" | "data" | "metric";

/** 返回证据种类; 无法识别可复现形式时返回 null */
export function evidenceKindOf(text: unknown): EvidenceKind | null {
  const t = String(text ?? "");
  if (/[0-9a-f]{7,40}\b[\s\S]{0,80}?[\w./-]+\.(ts|tsx|js|cjs|py|md|sql)(:\d+)?/.test(t)) return "code";
  // 2026-09-11 收紧(单元测试抓到两处缺陷): (1) 原先用 \b 前置边界, 而 /api/ 以非词字符开头,
  //   "GET /api/..." 永远不匹配 -> 改为 [^a-z0-9] 边界; (2) 原先允许裸 "=", 而 SQL 自身满是 "=",
  //   查询里 WHERE x=... 之后再跟 30 字符即算"结果" -> 改为一律要求 -> 或 => (真的结果标记).
  // 2026-09-11 缺陷修复(补证实测暴露, 不是放宽): 原判据把"命令"与"结果"的距离限制在 120 字符以内,
  //   后果有两个方向 —— (a) 带长条件的真实查询(>120 字符)被静默拒收; (b) 短条件查询却因为
  //   最后一个子查询的 SELECT 恰好离箭头近而"意外通过"。判据实际在测距离, 不是在测有没有结果。
  //   改为: 以**最后一个** -> / => 为界, 之前含命令/SQL/接口标记, 之后是结果文本(>=30 字符)。
  const arrowAt = Math.max(t.lastIndexOf("->"), t.lastIndexOf("=>"));
  if (arrowAt > 0) {
    const head = t.slice(0, arrowAt);
    const tail = t.slice(arrowAt + 2);
    if (/(?:^|[^a-z0-9])(select|get|post|\/api\/)/i.test(head) && tail.trim().length >= 30) return "data";
  }
  if (/\d+(\.\d+)?\s*(->|→)\s*\d+(\.\d+)?/.test(t)) return "metric";
  return null;
}

/**
 * 就地校验 finding 的证据. 合格则写入 f.evidenceKind 并返回 true;
 * 不合格则置 f.staleEvidence=true、追加说明并返回 false (调用方不得置 RESOLVED).
 */
export function requireEvidence(f: Record<string, unknown>): boolean {
  const kind = evidenceKindOf(String(f.evidenceRef ?? "") + " " + String(f.resolutionNote ?? ""));
  if (kind) { f.evidenceKind = kind; return true; }
  f.staleEvidence = true;
  f.resolutionNote =
    String(f.resolutionNote ?? "") +
    " [证据不合格: 缺可复现形式(commit+文件/SQL+返回/before->after), 未置 RESOLVED]";
  return false;
}
