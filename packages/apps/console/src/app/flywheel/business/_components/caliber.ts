import type { ActionSpec, DimensionSpec, MetricSpec, Status } from "./types";

// 业务看板的“口径字典”：每个数字都必须能回答
// 值 / 方向 / 阈值 / 口径 / 来源 / 责任人 / 复算命令 / NO_DATA。
// 页面只做展示，不在这里重算 canonical 指标。

export const num = (v: any): number | null => {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
export const ci = (v: any): string => {
  const x = num(v);
  return x == null ? "—" : Math.round(x).toLocaleString("zh-CN");
};
export const cp = (v: any, d = 2): string => {
  const x = num(v);
  return x == null ? "不可测" : x.toFixed(d) + "%";
};
export const ch = (v: any): string => {
  const x = num(v);
  return x == null ? "不可测" : x.toFixed(1) + " 小时";
};
export const ct = (v: any): string => {
  const x = num(v);
  if (x == null) return "不可测";
  if (x >= 1e9) return (x / 1e9).toFixed(2) + " 十亿";
  if (x >= 1e6) return (x / 1e6).toFixed(1) + " 百万";
  if (x >= 1e3) return (x / 1e3).toFixed(1) + " 千";
  return x.toLocaleString("zh-CN");
};
export const ctFull = (v: any): string => {
  const x = num(v);
  return x == null ? "不可测" : Math.round(x).toLocaleString("zh-CN");
};
export const ctime = (iso: any): string => {
  if (!iso) return "无数据";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "无数据";
  return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
};
const B = (s: any) => (s && s.business) || {};
const S = (s: any) => (s && s.business && s.business.sourceSnapshot) || {};
const W = (s: any) => (s && s.window) || {};

const atLeast = (v: any, ok: number, warn: number, dir: "up" | "down"): Status => {
  const x = num(v);
  if (x == null) return "nodata";
  if (dir === "up") return x >= ok ? "ok" : x >= warn ? "warn" : "crit";
  return x <= ok ? "ok" : x <= warn ? "warn" : "crit";
};

export const DIMENSIONS: DimensionSpec[] = [
  { id: "d1", code: "D1", title: "全貌", question: "对象有多大、结构怎样、连成网了吗？", href: "/flywheel/business/d1", owner: "数据/看板专项" },
  { id: "d2", code: "D2", title: "趋势", question: "现在正常吗？领先指标转向了吗？", href: "/flywheel/business/d2", owner: "飞轮线" },
  { id: "d3", code: "D3", title: "语义与数据健康", question: "每个数字什么意思、能不能信？", href: "/flywheel/business/d3", owner: "数据/看板专项" },
  { id: "d4", code: "D4", title: "瓶颈", question: "生产/消费卡在哪一段？", href: "/flywheel/business/d4", owner: "飞轮线" },
  { id: "d5", code: "D5", title: "成本", question: "每次有效交付花了多少词元？", href: "/flywheel/business/d5", owner: "mind 线" },
  { id: "d6", code: "D6", title: "风险与闭环", question: "完成可信吗？隔离和审计看得见吗？", href: "/flywheel/business/d6", owner: "平台安全 + 飞轮线" },
  { id: "d7", code: "D7", title: "组织与协同", question: "哪个智能体在干、干得怎么样？", href: "/flywheel/business/d7", owner: "组织 + mind 线" },
  { id: "d8", code: "D8", title: "指标到动作", question: "红了谁去动、动完怎么验？", href: "/flywheel/business/d8", owner: "各指标责任人" },
];

export const OWNERS = ["任务质量线", "飞轮线", "mind 线", "数据/看板专项", "组织", "平台安全"];

// ── L0 总览：8 张主卡 ─────────────────────────────────────────────────────
export function overviewMetrics(s: any): MetricSpec[] {
  const b = B(s);
  const c = (s && s.consumption && s.consumption.citations) || {};
  return [
    {
      key: "northStar", label: "北极星：被采用的认知（24 小时）", value: () => ci(c.events) + " 条",
      sub: () => "实时 " + ci(c.live) + " / 历史回填 " + ci(c.backfill),
      status: () => (num(c.events) ? (num(c.live) ? "ok" : "warn") : "nodata"),
      threshold: "实时引用 > 0", owner: "飞轮线",
      caliber: "被引用/回填的认知条数；周口径尚不可测，24 小时只作过渡信号。",
      source: "快照 · 消费 · 引用", verify: "node scripts/flywheel-report.cjs --format=json",
      note: "回填 162 是历史回填，不等于本周新采用；实时 0 说明前向引用还没接上。",
      href: "/flywheel/business/d4",
    },
    {
      key: "agentDone", label: "智能体交付（24 小时）", value: () => ci(b.delivery && b.delivery.agentDone) + " 条",
      sub: () => "定时任务关单 " + ci(b.delivery && b.delivery.cronDone) + " / 系统 " + ci(b.delivery && b.delivery.doneBy && b.delivery.doneBy.system),
      status: () => (num(b.delivery && b.delivery.agentDone) ? "ok" : "crit"),
      threshold: "> 0", owner: "任务质量线",
      caliber: "完成者为智能体（而非定时任务）的完成记录；与自动关单分列。",
      source: "业务扩展 · 交付 · 完成者", verify: "node scripts/flywheel-business-report.cjs",
      note: "完成不等于交付：本窗口 10 条完成全部是定时任务自动关单。",
      href: "/flywheel/business/d4",
    },
    {
      key: "agentConv", label: "智能体转化率", value: () => cp(b.delivery && b.delivery.agentConversionPct),
      sub: () => "认领 " + ci(s && s.flow && s.flow.claims) + " / 去重任务 " + ci(s && s.flow && s.flow.distinctTasks),
      status: () => atLeast(b.delivery && b.delivery.agentConversionPct, 30, 5, "up"),
      threshold: "≥ 30%", owner: "任务质量线",
      caliber: "智能体交付数 / 非心跳认领数（24 小时滚动，UTC）。",
      source: "业务扩展 · 交付 · 智能体转化", verify: "node scripts/flywheel-business-report.cjs",
      note: "总转化率把定时任务也算进分子，不能当成交付。", href: "/flywheel/business/d4",
    },
    {
      key: "acceptCoverage", label: "验收覆盖（7 天，正式验收）", value: () => cp(b.delivery && b.delivery.acceptanceCoverage && b.delivery.acceptanceCoverage.runnerPct),
      sub: () => "完成 " + ci(b.delivery && b.delivery.acceptanceCoverage && b.delivery.acceptanceCoverage.done) + " / 有正式验收 " + ci(b.delivery && b.delivery.acceptanceCoverage && b.delivery.acceptanceCoverage.runner),
      status: () => atLeast(b.delivery && b.delivery.acceptanceCoverage && b.delivery.acceptanceCoverage.runnerPct, 90, 50, "up"),
      threshold: "≥ 90%", owner: "飞轮线 + mind 线",
      caliber: "近 7 天完成记录中，有正式验收（不含影子验收与历史回填）的比例。",
      source: "业务扩展 · 验收 · 覆盖", verify: "node scripts/check-flywheel-business.cjs",
      note: "另有影子验收 20 条（11 通过 / 9 失败），只做诊断，不改任务状态。", href: "/flywheel/business/d6",
    },
    {
      key: "churn", label: "重复认领倍数", value: () => (num(s && s.flow && s.flow.churn) == null ? "不可测" : num(s.flow.churn)!.toFixed(2) + " 倍"),
      sub: () => "认领 " + ci(s && s.flow && s.flow.claims) + " / 去重任务 " + ci(s && s.flow && s.flow.distinctTasks),
      status: () => atLeast(s && s.flow && s.flow.churn, 1.2, 2, "down"),
      threshold: "≤ 1.2 倍", owner: "飞轮线",
      caliber: "认领次数 / 去重任务数（24 小时；已排除心跳续约）。",
      source: "快照 · 流转 · 重复认领", verify: "node scripts/flywheel-report.cjs",
      note: "头号人为原因是启动孤儿回收：上一实例退出会把在飞任务放回。", href: "/flywheel/business/d4",
    },
    {
      key: "queue3d", label: "队列 3 天以上占比", value: () => cp(b.queue && b.queue.age3dPct),
      sub: () => "待认领 " + ci(s && s.queue && s.queue.PENDING) + " / 从未认领 " + cp(b.queue && b.queue.neverClaimedPct),
      status: () => atLeast(b.queue && b.queue.age3dPct, 30, 70, "down"),
      threshold: "< 30%", owner: "飞轮线",
      caliber: "待认领任务中创建超过 3 天的占比；与“从未认领”并列看。",
      source: "快照 · 队列 · 年龄", verify: "node scripts/flywheel-report.cjs",
      note: "存量在老化，不是在被消化；净增转正不等于好转。", href: "/flywheel/business/d4",
    },
    {
      key: "channelRelease", label: "通道类放回（全部放回口径）", value: () => cp(s && s.causes && s.causes.releaseShare && s.causes.releaseShare.channelPct),
      sub: () => "隔离口径 " + cp(s && s.causes && s.causes.blocked && s.causes.blocked.channelPct),
      status: () => atLeast(s && s.causes && s.causes.releaseShare && s.causes.releaseShare.channelPct, 10, 30, "down"),
      threshold: "≤ 10%", owner: "飞轮线",
      caliber: "通道类（大脑通道 + 外部故障）放回 / 全部放回；隔离口径是另一个分母。",
      source: "快照 · 归因 · 放回", verify: "node scripts/flywheel-report.cjs",
      note: "两个分母不能混说：全部放回 48.39%，隔离口径 0%。", href: "/flywheel/business/d6",
    },
    {
      key: "health", label: "数据健康分", value: () => (num(b.health && b.health.score) == null ? "不可测" : ci(b.health.score) + " / 100"),
      sub: () => "红线 " + ci(b.health && b.health.redlines && b.health.redlines.length) + " 项",
      status: () => atLeast(b.health && b.health.score, 80, 60, "up"),
      threshold: "≥ 60 且无红线", owner: "数据/看板专项",
      caliber: "按新鲜度/完整性/一致性/唯一性/有效性五项违规率扣分；有红线封顶 60。",
      source: "业务扩展 · 数据健康", verify: "node scripts/check-flywheel-business.cjs",
      note: "它衡量“数字能不能信”，不是业务 KPI。", href: "/flywheel/business/d3",
    },
  ];
}

// ── 8 维下钻指标 ──────────────────────────────────────────────────────────
export function dimensionMetrics(id: string, s: any): MetricSpec[] {
  const b = B(s);
  const h = b.health || {};
  const d = b.delivery || {};
  const q = b.queue || {};
  const a = b.assets || {};
  const cost = b.cost || {};
  const org = b.org || {};
  const au = b.audit || {};
  const hist = b.history || {};
  const mk = (k: string, label: string, value: (x: any) => string, status: (x: any) => Status, threshold: string, owner: string, caliber: string, source: string, verify: string, note?: string): MetricSpec => ({ key: k, label, value, status, threshold, owner, caliber, source, verify, note });

  if (id === "d1") {
    const total = ["Memory", "Knowledge", "Practice", "Skill"].reduce((x, k) => x + (num(a.totals && a.totals[k]) || 0), 0);
    return [
      mk("assetsTotal", "认知资产总量", () => ctFull(total), () => "info", "只增不减", "数据/看板专项", "记忆+知识+实践+技能（未撤回、非 stale）。", "业务扩展 · 资产 · 总量", "node scripts/flywheel-business-report.cjs", "与调研稿 16:10 的数字不可直接比：资产表被清理过。"),
      mk("memory", "记忆", () => ctFull(a.totals && a.totals.Memory), () => "info", "—", "数据/看板专项", "未撤回的记忆条数。", "业务扩展 · 资产 · 记忆", "node scripts/flywheel-business-report.cjs"),
      mk("knowledge", "知识", () => ctFull(a.totals && a.totals.Knowledge), () => "info", "—", "数据/看板专项", "未撤回且非 stale 的知识条数。", "业务扩展 · 资产 · 知识", "node scripts/flywheel-business-report.cjs"),
      mk("practice", "实践", () => ctFull(a.totals && a.totals.Practice), () => "info", "—", "数据/看板专项", "未撤回且非 stale 的实践条数。", "业务扩展 · 资产 · 实践", "node scripts/flywheel-business-report.cjs"),
      mk("skill", "技能", () => ctFull(a.totals && a.totals.Skill), () => "info", "—", "数据/看板专项", "未撤回且非 stale 的技能条数。", "业务扩展 · 资产 · 技能", "node scripts/flywheel-business-report.cjs"),
      mk("connMemory", "实践→记忆连接密度", () => cp(a.connections && a.connections.memory && a.connections.memory.pct), () => atLeast(a.connections && a.connections.memory && a.connections.memory.pct, 50, 20, "up"), "≥ 50%", "飞轮线", "有记忆连接的实践 / 全部实践。", "业务扩展 · 资产 · 连接", "node scripts/flywheel-business-report.cjs", "连接稀 = 经验没有挂到用过的认知上。"),
      mk("connKnowledge", "实践→知识连接密度", () => cp(a.connections && a.connections.knowledge && a.connections.knowledge.pct), () => atLeast(a.connections && a.connections.knowledge && a.connections.knowledge.pct, 50, 20, "up"), "≥ 50%", "飞轮线", "有知识连接的实践 / 全部实践。", "业务扩展 · 资产 · 连接", "node scripts/flywheel-business-report.cjs"),
      mk("connSkill", "实践→技能连接密度", () => cp(a.connections && a.connections.skill && a.connections.skill.pct), () => atLeast(a.connections && a.connections.skill && a.connections.skill.pct, 50, 20, "up"), "≥ 50%", "飞轮线", "有技能连接的实践 / 全部实践。", "业务扩展 · 资产 · 连接", "node scripts/flywheel-business-report.cjs"),
      mk("reflection", "反思双表", () => "主题 " + ctFull(a.reflection && a.reflection.topic) + " / 历史 " + ctFull(a.reflection && a.reflection.legacy), () => "warn", "权威表已定", "数据/看板专项", "主题反思与历史反思并列展示，不合并。", "业务扩展 · 资产 · 反思", "node scripts/flywheel-report.cjs", "两张表都在写；权威表未定。"),
      mk("skillLegacy", "技能遗留占比", () => cp(a.skillLegacy && a.skillLegacy.pct), () => atLeast(a.skillLegacy && a.skillLegacy.pct, 30, 60, "down"), "≤ 30%", "数据/看板专项", "标记为遗留（legacy）的技能 / 全部技能。", "业务扩展 · 资产 · 技能遗留", "node scripts/flywheel-business-report.cjs", "清理后只剩 23 条，已不是主要问题。"),
    ];
  }

  if (id === "d2") {
    const series = hist.series || [];
    const sum = (k: string) => series.reduce((x: number, r: any) => x + (num(r[k]) || 0), 0);
    const last = series.length ? series[series.length - 1] : {};
    return [
      mk("regime", "当前阶段", () => (b.regime && b.regime.current ? b.regime.current + " · " + b.regime.label : "不可测"), () => (b.regime && b.regime.comparable ? "ok" : "warn"), "同阶段才可比", "飞轮线", "按 UTC 自然日切分：R1 ≤ 10-08 / R2 10-09–10-21 / R3 ≥ 10-22。", "业务扩展 · 阶段", "node scripts/flywheel-business-report.cjs", "14 天窗口跨 R2/R3，不能把两段混成一条结论。"),
      mk("newTasks", "14 天新任务", () => ctFull(sum("newTasks")), () => "info", "—", "飞轮线", "按创建日汇总。", "业务扩展 · 趋势 · 新任务", "node scripts/flywheel-business-report.cjs"),
      mk("claims", "14 天认领", () => ctFull(sum("claims")), () => "info", "—", "飞轮线", "进入进行中且排除心跳续约。", "业务扩展 · 趋势 · 认领", "node scripts/flywheel-business-report.cjs"),
      mk("done", "14 天完成", () => ctFull(sum("done")), () => "info", "—", "飞轮线", "含定时任务自动关单。", "业务扩展 · 趋势 · 完成", "node scripts/flywheel-business-report.cjs"),
      mk("agentDone", "14 天智能体交付", () => ctFull(sum("agentDone")), () => atLeast(sum("agentDone"), 50, 10, "up"), "> 0", "任务质量线", "完成者为智能体（而非定时任务）的完成记录。", "业务扩展 · 趋势 · 智能体交付", "node scripts/flywheel-business-report.cjs", "最近 5 天为 0。"),
      mk("zeroDays", "零事件天数", () => ctFull((hist.zeroEventDays || []).length) + " 天", () => ((hist.zeroEventDays || []).length ? "crit" : "ok"), "0 天", "飞轮线", "当日新任务/认领/完成都为 0。", "业务扩展 · 趋势 · 零事件", "node scripts/flywheel-business-report.cjs", "10-07/08 历史停摆先例，监控必须能识别。"),
      mk("lastOutput", "最近一日产出", () => ctFull(Object.values(last.output || {}).reduce((x: number, v: any) => x + (num(v) || 0), 0)), () => "info", "—", "mind 线", "记忆+知识+实践+技能。", "业务扩展 · 趋势 · 产出", "node scripts/flywheel-business-report.cjs"),
      mk("lastStructured", "最近一日结构化", () => ctFull(last.structured), () => atLeast(last.structured, 10, 1, "up"), "≥ 10", "mind 线", "FLYWHEEL_STRUCTURED 产物。", "业务扩展 · 趋势 · 结构化", "node scripts/flywheel-business-report.cjs"),
    ];
  }

  if (id === "d3") {
    return [
      mk("healthScore", "数据健康分", () => ci(h.score) + " / 100", () => atLeast(h.score, 80, 60, "up"), "≥ 60 且无红线", "数据/看板专项", "按违规率扣分；红线封顶 60。", "业务扩展 · 数据健康", "node scripts/check-flywheel-business.cjs"),
      mk("redlines", "红线项", () => ci(h.redlines && h.redlines.length) + " 项", () => ((h.redlines || []).length ? "crit" : "ok"), "0 项", "数据/看板专项", "验收覆盖/重复组/词元归因/双表。", "业务扩展 · 数据健康 · 红线", "node scripts/check-flywheel-business.cjs"),
      mk("noData", "无数据 / 不完整项", () => ci((b.noData || []).length) + " 项", () => ((b.noData || []).length ? "warn" : "ok"), "0 项", "数据/看板专项", "无数据不等于达标；每项都带原因与复算命令。", "业务扩展 · 无数据清单", "node scripts/check-flywheel-business.cjs"),
      mk("freshStructured", "结构化新鲜度", () => ch(b.freshness && b.freshness.structuredAgeHours), () => atLeast(b.freshness && b.freshness.structuredAgeHours, 24, 48, "down"), "≤ 24 小时", "mind 线", "最后一次 FLYWHEEL_STRUCTURED 写入距今。", "业务扩展 · 新鲜度 · 结构化", "node scripts/flywheel-report.cjs"),
      mk("freshExtraction", "抽取账本新鲜度", () => ch(b.freshness && b.freshness.extractionAgeHours), () => atLeast(b.freshness && b.freshness.extractionAgeHours, 24, 72, "down"), "≤ 24 小时", "mind 线", "会话抽取账本最后写入距今。", "业务扩展 · 新鲜度 · 抽取账本", "node scripts/flywheel-report.cjs", "账本停更会让生产漏斗第一段不可测。"),
      mk("freshVerdict", "验收新鲜度", () => ch(b.freshness && b.freshness.verdictAgeHours), () => atLeast(b.freshness && b.freshness.verdictAgeHours, 24, 72, "down"), "≤ 24 小时", "飞轮线", "最后一次验收判定距今。", "业务扩展 · 新鲜度 · 验收", "node scripts/flywheel-report.cjs", "注意：这个时刻可能来自影子验收，页面下方分 source 展示。"),
      mk("consistency", "一致性", () => (a.reflection && a.reflection.canonical === "decided" ? "已收口" : "双表未收口"), () => (a.reflection && a.reflection.canonical === "decided" ? "ok" : "warn"), "已收口", "数据/看板专项", "反思双表、时间类型、空遗留表。", "业务扩展 · 资产 · 反思", "node scripts/flywheel-report.cjs"),
    ];
  }

  if (id === "d4") {
    return [
      mk("neverClaimed", "从未认领占比", () => cp(q.neverClaimedPct), () => atLeast(q.neverClaimedPct, 50, 70, "down"), "≤ 50%", "任务质量线", "待认领中从未进入进行中的占比。", "业务扩展 · 队列 · 从未认领", "node scripts/flywheel-business-report.cjs", "大存量没人碰 + 小热集高重复认领，是二元结构。"),
      mk("firstClaim", "首次认领等待（P50）", () => ch(q.firstClaimWait && q.firstClaimWait.p50Hours), () => atLeast(q.firstClaimWait && q.firstClaimWait.p50Hours, 24, 72, "down"), "≤ 24 小时", "飞轮线", "14 天内任务从创建到首次认领的中位时长。", "业务扩展 · 队列 · 首次认领", "node scripts/flywheel-business-report.cjs", "P50 约 8.3 天，派单严重滞后。"),
      mk("queue3d", "队列 3 天以上占比", () => cp(q.age3dPct), () => atLeast(q.age3dPct, 30, 70, "down"), "< 30%", "飞轮线", "待认领任务中创建超过 3 天的占比。", "快照 · 队列 · 年龄", "node scripts/flywheel-report.cjs"),
      mk("conversion", "总转化率", () => cp(s && s.flow && s.flow.conversionPct), () => atLeast(s && s.flow && s.flow.conversionPct, 30, 5, "up"), "≥ 30%", "任务质量线", "完成 / 认领；完成含定时任务自动关单，仅作参考。", "快照 · 流转 · 转化", "node scripts/flywheel-report.cjs"),
      mk("structured", "结构化产出（24 小时）", () => ctFull(Object.values((s && s.output && s.output.format) || {}).reduce((x: number, v: any) => x + (num(v && v.n) || 0), 0)), () => { const n = Number(Object.values((s && s.output && s.output.format) || {}).reduce((x: number, v: any) => x + (num(v && v.n) || 0), 0)); return n > 10 ? "ok" : n >= 10 ? "warn" : "crit"; }, "> 10（10 为刚过线）", "mind 线", "记忆/知识/实践的 FLYWHEEL_STRUCTURED 条数；小样本不判格式。", "快照 · 产出 · 格式", "node scripts/flywheel-report.cjs"),
      mk("newTasks", "新任务（24 小时）", () => ctFull(s && s.flow && s.flow.newTasks), () => atLeast(s && s.flow && s.flow.newTasks, 200, 50, "up"), "≥ 200", "飞轮线", "窗口内新建任务。", "快照 · 流转 · 新增", "node scripts/flywheel-report.cjs", "进水口枯竭时，净增稳定是假信号。"),
      mk("injected", "注入量（24 小时）", () => ctFull(s && s.consumption && s.consumption.injected), () => "info", "—", "飞轮线", "上下文注入事件数。", "快照 · 消费 · 注入", "node scripts/flywheel-report.cjs"),
      mk("used", "注入后走完提交", () => cp(s && s.consumption && s.consumption.usedOverInjectedPct), () => atLeast(s && s.consumption && s.consumption.usedOverInjectedPct, 30, 1, "up"), "≥ 30%", "任务质量线", "记使用只在提交成功时计一次，不是阅读率。", "快照 · 消费 · 记使用", "node scripts/flywheel-report.cjs", "0% 说明断在交付，不是“智能体没读”。"),
    ];
  }

  if (id === "d5") {
    const llm = cost.llm || {};
    return [
      mk("gatewayTokens", "网关词元总量（24 小时）", () => ct(cost.gateway && cost.gateway.tokens), () => (cost.gateway && cost.gateway.available ? "info" : "nodata"), "通道级精确", "数据/看板专项", "网关侧精确总量；成本以此为准。", "业务扩展 · 成本 · 网关", "node scripts/gateway-token-report.cjs --days=1 --json"),
      mk("gatewayCalls", "网关调用数", () => ctFull(cost.gateway && cost.gateway.calls), () => "info", "—", "数据/看板专项", "网关侧调用次数。", "业务扩展 · 成本 · 网关", "node scripts/gateway-token-report.cjs --days=1 --json"),
      mk("platformTokens", "平台内部词元", () => ct(cost.platform && cost.platform.tokens), () => "info", "精确", "mind 线", "平台内部模型调用；单列，不与网关相加。", "业务扩展 · 成本 · 平台", "node scripts/gateway-token-report.cjs --days=1 --json"),
      mk("agentCoverage", "逐智能体归因覆盖", () => cp(cost.agent && cost.agent.coveragePct), () => atLeast(cost.agent && cost.agent.coveragePct, 95, 50, "up"), "≥ 95%", "mind 线", "逐调用上报且带词元的事件 / 全部真实调用。", "业务扩展 · 成本 · 归因", "node scripts/check-token-coverage.cjs", "上游常不返回用量；只做归因参考，不与网关相加。"),
      mk("emptyRate", "空输出率", () => cp(llm.emptyPct), () => atLeast(llm.emptyPct, 25, 50, "down"), "≤ 25%", "mind 线 + 组织", "空输出 / 全部调用。", "业务扩展 · 成本 · 调用", "node scripts/agent-fairness.cjs --days=7"),
      mk("rateLimit", "限流率", () => cp(llm.rateLimitPct), () => atLeast(llm.rateLimitPct, 10, 20, "down"), "≤ 10%", "mind 线", "限流 / 全部调用。", "业务扩展 · 成本 · 调用", "node scripts/agent-fairness.cjs --days=7"),
      mk("perDelivery", "每交付调用", () => (num(d.agentDone) ? ctFull((num(llm.total) || 0) / num(d.agentDone)!) + " 次/条" : "无数据（交付为 0）"), () => (num(d.agentDone) ? "info" : "nodata"), "越低越好", "mind 线", "调用总数 / 智能体交付数；交付为 0 时不可算。", "业务扩展 · 成本 · 单位经济", "node scripts/flywheel-business-report.cjs", "不拿 0 做分母。"),
      mk("unitPrice", "单价 / 金额", () => (cost.unitPriceCny == null ? "未配置（不出金额）" : cost.unitPriceCny + " 元/千词元"), () => "nodata", "已配置", "数据/看板专项", "未配单价，金额只能按月合同分摊，不能出精确金额。", "业务扩展 · 成本 · 单价", "node scripts/flywheel-business-report.cjs", "这是未决口径，不是页面缺陷。"),
    ];
  }

  if (id === "d6") {
    const ac = b.acceptance || {};
    const cov = d.acceptanceCoverage || {};
    return [
      mk("runnerCoverage", "正式验收覆盖（7 天）", () => cp(cov.runnerPct), () => atLeast(cov.runnerPct, 90, 50, "up"), "≥ 90%", "飞轮线 + mind 线", "有正式验收（不含影子验收/历史回填）的完成记录 / 全部完成。", "业务扩展 · 验收 · 覆盖", "node scripts/check-flywheel-business.cjs"),
      mk("shadow", "影子验收（诊断）", () => "通过 " + ci(ac.shadow && ac.shadow.pass) + " / 失败 " + ci(ac.shadow && ac.shadow.fail), () => "warn", "人工一致率", "飞轮线", "只写验收记录，不改任务状态；是否进质量指标未定。", "业务扩展 · 验收 · 影子", "node scripts/acceptance/shadow-sweep.cjs --days=7 --limit=20", "20 条人工 20/20 一致；失败都是零有效动作。"),
      mk("cronDone", "定时任务关单比", () => cp(d.cronDonePct), () => atLeast(d.cronDonePct, 30, 60, "down"), "< 30%", "任务质量线", "定时任务完成 / 全部完成；识别“假交付”。", "业务扩展 · 交付 · 完成者", "node scripts/flywheel-business-report.cjs"),
      mk("blocked", "隔离存量", () => ctFull(s && s.queue && s.queue.BLOCKED), () => atLeast(s && s.queue && s.queue.BLOCKED, 500, 1000, "down"), "持续下降", "飞轮线", "当前隔离任务数；24 小时新增 48，租约到期占 93.75%。", "快照 · 队列 · 隔离", "node scripts/flywheel-report.cjs", "隔离多说明“领了不做”。"),
      mk("auditEvents", "审计记录（24 小时）", () => ctFull(au.events), () => (num(au.events) ? "warn" : "nodata"), "五类均有记录", "平台安全", "本地墙钟窗口；高危 " + ci(au.highRisk) + " 条。", "业务扩展 · 审计", "node scripts/audit-report.cjs --days=1", "时间按 Asia/Shanghai 本地展示，与业务 UTC 分开。"),
      mk("humanDecision", "人类决策积压", () => "进行中 " + ci(s && s.closedLoop && s.closedLoop.humanDecision && s.closedLoop.humanDecision.doing), () => atLeast(s && s.closedLoop && s.closedLoop.humanDecision && s.closedLoop.humanDecision.doing, 0, 20, "down"), "0", "平台安全", "需要人决策的待办；p50 时延 " + ch(s && s.closedLoop && s.closedLoop.humanDecision && s.closedLoop.humanDecision.p50Hours) + "。", "快照 · 闭环 · 人类决策", "node scripts/flywheel-report.cjs"),
      mk("pollution", "测试污染", () => ctFull(Object.values((s && s.hygiene && s.hygiene.testPollution) || {}).reduce((x: number, v: any) => x + (num(v) || 0), 0)), () => (Number(Object.values((s && s.hygiene && s.hygiene.testPollution) || {}).reduce((x: number, v: any) => x + (num(v) || 0), 0)) > 0 ? "warn" : "ok"), "0 行", "质量线", "自检前缀/theme=t 写进生产资产表的行数。", "快照 · 卫生 · 测试污染", "node scripts/flywheel-report.cjs"),
    ];
  }

  if (id === "d7") {
    const worst = (org.emptyOutputByAgent || []).slice().sort((x: any, y: any) => (num(y.emptyPct) || 0) - (num(x.emptyPct) || 0))[0];
    return [
      mk("active", "注册在用智能体", () => ci(org.activeCount) + " / " + ci((org.activeCount || 0) + (org.inactiveCount || 0)), () => "info", "—", "组织", "注册状态为 ACTIVE 的智能体；心跳不等于在工作。", "业务扩展 · 组织 · 注册", "node scripts/flywheel-business-report.cjs", "当前智能体交付 0，不能把心跳当产出。"),
      mk("claims", "认领（24 小时）", () => ctFull((org.claimsByAgent || []).reduce((x: number, r: any) => x + (num(r.n) || 0), 0)), () => "info", "—", "飞轮线", "按执行者聚合。", "业务扩展 · 组织 · 认领", "node scripts/flywheel-business-report.cjs"),
      mk("done", "智能体交付（24 小时）", () => ctFull(d.agentDone), () => atLeast(d.agentDone, 1, 0, "up"), "> 0", "任务质量线", "完成者为智能体（而非定时任务）的完成记录。", "业务扩展 · 组织 · 交付", "node scripts/flywheel-business-report.cjs"),
      mk("orphan", "孤儿回收", () => ctFull(org.orphanRecoveries), () => atLeast(org.orphanRecoveries, 100, 300, "down"), "< 100 / 24h", "飞轮线", "启动孤儿回收事件；重复认领的头号人为原因。", "业务扩展 · 组织 · 孤儿回收", "node scripts/flywheel-report.cjs"),
      mk("skipped", "健康闸门跳过", () => ctFull(org.claimSkipped), () => "info", "—", "任务质量线", "被健康闸门拦下的认领。", "业务扩展 · 组织 · 闸门", "node scripts/flywheel-report.cjs"),
      mk("worstEmpty", "最差空输出", () => (worst ? (worst.agentId || worst.agent) + " " + cp(worst.emptyPct) : "无数据"), () => (worst ? atLeast(worst.emptyPct, 25, 50, "down") : "nodata"), "≤ 25%", "mind 线 + 组织", "按智能体拆分空输出率。", "业务扩展 · 组织 · 空输出", "node scripts/agent-fairness.cjs --days=7"),
      mk("fairness", "跨智能体公平性", () => "需分层后才能判", () => "nodata", "同层差异 ±5pp", "组织", "按任务类型 × 描述体量分层比较，不能直接比总量。", "未纳入快照", "node scripts/agent-fairness.cjs --days=7", "本页不直接下“谁不行”的结论。"),
    ];
  }

  // d8
  const bad = ACTIONS.filter((x) => x.status(s) !== "ok");
  return [
    mk("redCount", "红色动作项", () => ci(bad.length) + " 项", () => (bad.length ? "crit" : "ok"), "0 项", "各指标责任人", "所有未达阈值的动作项；每项带责任人/动作/复算。", "动作表", "node scripts/check-flywheel-business.cjs"),
    mk("owners", "涉及责任人", () => ci(new Set(bad.map((x) => x.owner)).size) + " 个", () => "info", "—", "各指标责任人", "红色项按 owner 去重。", "动作表", "node scripts/check-flywheel-business.cjs"),
    mk("topRisk", "第一优先", () => (bad[0] ? bad[0].metric : "无"), () => (bad.length ? "crit" : "ok"), "清零", "各指标责任人", "按动作表顺序的第一条红色项。", "动作表", bad[0] ? bad[0].verify : "node scripts/check-flywheel-business.cjs", "先修验收与交付，再修展示。"),
    mk("verifyCoverage", "带复算命令的比例", () => cp((bad.filter((x) => x.verify).length / Math.max(bad.length, 1)) * 100, 0), () => "ok", "100%", "数据/看板专项", "每条红色动作都必须有可复算命令。", "动作表", "node scripts/check-flywheel-business.cjs"),
  ];
}

// ── 动作表：指标 → owner → 阈值 → 动作 → 复核 ─────────────────────────────
export const ACTIONS: ActionSpec[] = [
  {
    key: "acceptCoverage", dim: "d6", metric: "正式验收覆盖（7 天）",
    current: (s) => cp(B(s).delivery && B(s).delivery.acceptanceCoverage && B(s).delivery.acceptanceCoverage.runnerPct),
    threshold: "≥ 90%", owner: "飞轮线 + mind 线",
    action: "恢复验收 sweep 或对完成记录做抽样复算；影子验收只做诊断，不进正式通过率。",
    verify: "node scripts/acceptance/shadow-sweep.cjs --days=7 --limit=20",
    status: (s) => atLeast(B(s).delivery && B(s).delivery.acceptanceCoverage && B(s).delivery.acceptanceCoverage.runnerPct, 90, 50, "up"),
    note: "没有验收，“完成”只是自称完成。",
  },
  {
    key: "agentConv", dim: "d4", metric: "智能体转化率",
    current: (s) => cp(B(s).delivery && B(s).delivery.agentConversionPct),
    threshold: "≥ 30%", owner: "任务质量线",
    action: "拆拒因：通道/证据/无改动/无提交，分别派单；主指标用智能体交付，不用总完成。",
    verify: "node scripts/flywheel-business-report.cjs --format=json",
    status: (s) => atLeast(B(s).delivery && B(s).delivery.agentConversionPct, 30, 5, "up"),
    note: "本窗口智能体交付 0。",
  },
  {
    key: "churn", dim: "d4", metric: "重复认领倍数",
    current: (s) => (num(s.flow && s.flow.churn) == null ? "不可测" : num(s.flow.churn)!.toFixed(2) + " 倍"),
    threshold: "≤ 1.2 倍", owner: "飞轮线",
    action: "查最近重启/部署与启动孤儿回收；先降回收，再谈算法。",
    verify: "node scripts/flywheel-report.cjs",
    status: (s) => atLeast(s.flow && s.flow.churn, 1.2, 2, "down"),
    note: "孤儿回收 275 次/24 小时。",
  },
  {
    key: "queue3d", dim: "d4", metric: "队列 3 天以上占比",
    current: (s) => cp(B(s).queue && B(s).queue.age3dPct),
    threshold: "< 30%", owner: "飞轮线",
    action: "查派单面与任务可执行性；把“从未认领”与“重复认领”分开治。",
    verify: "node scripts/flywheel-report.cjs",
    status: (s) => atLeast(B(s).queue && B(s).queue.age3dPct, 30, 70, "down"),
  },
  {
    key: "neverClaimed", dim: "d4", metric: "从未认领占比",
    current: (s) => cp(B(s).queue && B(s).queue.neverClaimedPct),
    threshold: "≤ 50%", owner: "任务质量线",
    action: "抽样看任务描述/依赖/可执行性；不是所有存量都值得派。",
    verify: "node scripts/flywheel-business-report.cjs",
    status: (s) => atLeast(B(s).queue && B(s).queue.neverClaimedPct, 50, 70, "down"),
  },
  {
    key: "channelRelease", dim: "d6", metric: "通道类放回（全部放回）",
    current: (s) => cp(s.causes && s.causes.releaseShare && s.causes.releaseShare.channelPct),
    threshold: "≤ 10%", owner: "飞轮线",
    action: "查网关鉴权/限流/超时；与隔离口径分开报，不混分母。",
    verify: "node scripts/gateway-token-report.cjs --days=1 --json",
    status: (s) => atLeast(s.causes && s.causes.releaseShare && s.causes.releaseShare.channelPct, 10, 30, "down"),
    note: "隔离口径当前 0%。",
  },
  {
    key: "empty", dim: "d5", metric: "空输出率",
    current: (s) => cp(B(s).cost && B(s).cost.llm && B(s).cost.llm.emptyPct),
    threshold: "≤ 25%", owner: "mind 线 + 组织",
    action: "分智能体查提示词/超时/模型；必要时降并发，不要只看总量。",
    verify: "node scripts/agent-fairness.cjs --days=7",
    status: (s) => atLeast(B(s).cost && B(s).cost.llm && B(s).cost.llm.emptyPct, 25, 50, "down"),
  },
  {
    key: "structured", dim: "d4", metric: "结构化产出（24 小时）",
    current: (s) => ctFull(Object.values((s.output && s.output.format) || {}).reduce((x: number, v: any) => x + (num(v && v.n) || 0), 0)),
    threshold: "> 10（10 为刚过线）", owner: "mind 线",
    action: "查定时任务/额度/输入；结构化是任务生成的进水口。",
    verify: "node scripts/flywheel-report.cjs",
    status: (s) => { const n = Number(Object.values((s.output && s.output.format) || {}).reduce((x: number, v: any) => x + (num(v && v.n) || 0), 0)); return n > 10 ? "ok" : n >= 10 ? "warn" : "crit"; },
  },
  {
    key: "tokenCov", dim: "d5", metric: "逐智能体词元归因覆盖",
    current: (s) => cp(B(s).cost && B(s).cost.agent && B(s).cost.agent.coveragePct),
    threshold: "≥ 95%", owner: "mind 线 + 数据/看板专项",
    action: "采用通道级为总量；逐智能体只做归因参考，补上游 usage 或回读网关记录。",
    verify: "node scripts/check-token-coverage.cjs",
    status: (s) => atLeast(B(s).cost && B(s).cost.agent && B(s).cost.agent.coveragePct, 95, 50, "up"),
  },
  {
    key: "reflection", dim: "d1", metric: "反思双表",
    current: (s) => "主题 " + ctFull(B(s).assets && B(s).assets.reflection && B(s).assets.reflection.topic) + " / 历史 " + ctFull(B(s).assets && B(s).assets.reflection && B(s).assets.reflection.legacy),
    threshold: "权威表已定", owner: "数据/看板专项",
    action: "先定权威表，再决定是否合并；看板当前并列展示，不合并。",
    verify: "node scripts/flywheel-report.cjs",
    status: (s) => (B(s).assets && B(s).assets.reflection && B(s).assets.reflection.canonical === "decided" ? "ok" : "warn"),
  },
  {
    key: "audit", dim: "d6", metric: "审计五类覆盖",
    current: (s) => {
      const c = (B(s).audit && B(s).audit.classes) || {};
      const hit = ["asset", "access", "decision", "task", "system"].filter((k) => (num(c[k]) || 0) > 0).length;
      return hit + " / 5 类";
    },
    threshold: "五类均有记录", owner: "平台安全",
    action: "按类补真实 E2E；资产/决策/任务动作必须可追责。",
    verify: "node scripts/audit-report.cjs --days=7",
    status: (s) => {
      const c = (B(s).audit && B(s).audit.classes) || {};
      const hit = ["asset", "access", "decision", "task", "system"].filter((k) => (num(c[k]) || 0) > 0).length;
      return hit >= 5 ? "ok" : hit >= 3 ? "warn" : "crit";
    },
    note: "审计时间是本地墙钟（Asia/Shanghai）。",
  },
  {
    key: "dataHealth", dim: "d3", metric: "数据健康分",
    current: (s) => ci(B(s).health && B(s).health.score) + " / 100",
    threshold: "≥ 60 且无红线", owner: "数据/看板专项",
    action: "按新鲜度/完整性/一致性/唯一性/有效性逐项修；红线优先。",
    verify: "node scripts/check-flywheel-business.cjs",
    status: (s) => atLeast(B(s).health && B(s).health.score, 80, 60, "up"),
  },
  {
    key: "pollution", dim: "d6", metric: "测试污染",
    current: (s) => ctFull(Object.values((s.hygiene && s.hygiene.testPollution) || {}).reduce((x: number, v: any) => x + (num(v) || 0), 0)),
    threshold: "0 行", owner: "质量线",
    action: "自测隔离库 + 清存量（数据变更需单独授权）。",
    verify: "node scripts/flywheel-report.cjs",
    status: (s) => (Number(Object.values((s.hygiene && s.hygiene.testPollution) || {}).reduce((x: number, v: any) => x + (num(v) || 0), 0)) > 0 ? "warn" : "ok"),
  },
];

export function dimensionActions(id: string, s: any): ActionSpec[] {
  return ACTIONS.filter((a) => a.dim === id && a.status(s) !== "ok");
}

// L0 三条红线（验收 / 隔离 / 外部故障）
export function redLines(s: any) {
  const b = B(s);
  const cov = b.delivery && b.delivery.acceptanceCoverage;
  const shadow = b.acceptance && b.acceptance.shadow;
  const blocked = b.causes || (s && s.causes) || {};
  return [
    {
      key: "accept", title: "验收", value: cp(cov && cov.runnerPct), sub: "完成 " + ci(cov && cov.done) + " / 正式验收 " + ci(cov && cov.runner) + " · 影子 " + ci(shadow && shadow.total),
      status: atLeast(cov && cov.runnerPct, 90, 50, "up"),
      action: "恢复 sweep 或抽样复算", owner: "飞轮线 + mind 线", href: "/flywheel/business/d6",
    },
    {
      key: "blocked", title: "隔离", value: ctFull(s && s.queue && s.queue.BLOCKED), sub: "24 小时新增 " + ci(blocked && blocked.blocked && blocked.blocked.total) + " · 租约到期占 " + cp(blocked && blocked.blocked && blocked.blocked.pct && blocked.blocked.pct.leaseTtl),
      status: atLeast(s && s.queue && s.queue.BLOCKED, 500, 1000, "down"),
      action: "查“领了不做”与租约策略", owner: "飞轮线", href: "/flywheel/business/d4",
    },
    {
      key: "external", title: "外部故障", value: cp(s && s.causes && s.causes.releaseShare && s.causes.releaseShare.channelPct), sub: "全部放回口径 · 隔离口径 " + cp(s && s.causes && s.causes.blocked && s.causes.blocked.channelPct),
      status: atLeast(s && s.causes && s.causes.releaseShare && s.causes.releaseShare.channelPct, 10, 30, "down"),
      action: "先修通道，再修单", owner: "飞轮线", href: "/flywheel/business/d6",
    },
  ];
}
