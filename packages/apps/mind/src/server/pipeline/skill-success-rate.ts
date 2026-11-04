/**
 * skill-success-rate.ts — uos20 #8 Skills 成功率统计 (轻量版)
 *
 * 口径 (2026-09-11 operator 拍板 / 平台记忆 cmuc5i87t003k1hqrub6quq3y):
 *   - "生成即成功": 一次 skill 候选进入写入阶段且通过 SKILL-SPEC (content/steps >= 30 字)
 *     落 Skill 表即算成功; 无 steps 被降级进 knowledge(tags=skill-downgraded) 即算失败。
 *   - 分母 skillCandidatesTotal = skillsCreated + skillsDowngraded。
 *   - 成功率两位小数; 分母为 0 时返回 null (不伪造成 0, 避免"无候选"被误读成"全失败")。
 *
 * 根因 (平台记忆 cmuc5i8y600481hqrpge36ihb):
 *   旧实现把 skillsCreated 与降级数合并进 knowledgeCreated / totalRecordsCreated,
 *   skill 类型为 0 时被聚合掩盖, 成功率不可见。故按类型拆开独立追踪。
 *
 * 本模块为纯函数 (无 DB / 无 IO), 供 db-writer (运行时) 与 stats router (持久化按日)
 * 共用同一口径, 单测 tests 直接调用本函数, 不复刻公式。
 */

export interface SkillSuccessRate {
  /** 分子: 通过 SKILL-SPEC 校验并落 Skill 表的技能数 (含同名 upsert 更新) */
  skillsCreated: number;
  /** 降级数: 无 steps 被降级进 knowledge(skill-downgraded) 的技能候选数 */
  skillsDowngraded: number;
  /** 分母: 本次提取提出的技能候选总数 = skillsCreated + skillsDowngraded */
  skillCandidatesTotal: number;
  /** 成功率 (0~1, 两位小数); 分母为 0 时为 null */
  skillSuccessRate: number | null;
  /** 成功率百分比 (0~100, 两位小数); 分母为 0 时为 null */
  skillSuccessRatePct: number | null;
}

function nonNegInt(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

/** 两位小数取整 (四舍五入, 消除浮点尾差) */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * 由分子/降级数计算 Skills 成功率。
 * 不读 DB; 调用方负责把原始分子分母一并暴露 (可复算)。
 */
export function computeSkillSuccessRate(skillsCreated: unknown, skillsDowngraded: unknown): SkillSuccessRate {
  const created = nonNegInt(skillsCreated);
  const downgraded = nonNegInt(skillsDowngraded);
  const total = created + downgraded;
  if (total === 0) {
    return {
      skillsCreated: created,
      skillsDowngraded: downgraded,
      skillCandidatesTotal: 0,
      skillSuccessRate: null,
      skillSuccessRatePct: null,
    };
  }
  const rate = created / total;
  return {
    skillsCreated: created,
    skillsDowngraded: downgraded,
    skillCandidatesTotal: total,
    skillSuccessRate: round2(rate),
    skillSuccessRatePct: round2(rate * 100),
  };
}
