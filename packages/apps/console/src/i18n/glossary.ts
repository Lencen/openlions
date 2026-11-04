// 2026-09-14 文案业务化 (待办 todo_c0c8aee4ca134af0b5ed):
// 业务化用语**对照表** —— 技术词 -> 业务说法 的单一事实源。
// 约束:
//   1) 界面上出现的技术词, 一律优先走本表映射 (bizTerm) 或集中文案 (t), 不允许散落在各页面硬编码;
//   2) 本表同时供文档 docs/platform-logic/ui-copy-business-glossary-2026-09-14.md 与守门脚本读取;
//   3) 后续多语言: 术语的业务说法进 messages/<locale>.ts, 本表只保留"技术词 -> 业务键"的骨架。
//
// 说明: "技术词" 指代码/协议/内部实体名 (如 TaskExecution / MCP / RBAC); 业务说法是给业务方看的中文。

export interface GlossaryEntry {
  /** 技术词 (代码/协议/内部实体名, 大小写敏感) */
  tech: string;
  /** 业务说法 (界面展示用中文) */
  biz: string;
  /** 说明: 为什么这样翻译 / 保留哪些注释 */
  note?: string;
}

/** 业务化用语对照表 (排序: 先实体名, 再协议/缩写, 再通用词) */
export const TERM_GLOSSARY: GlossaryEntry[] = [
  // —— 内部实体 / 数据表 ——
  { tech: 'ImprovementAction', biz: '改进任务', note: '飞轮机制修复类任务, 要求复测证据' },
  { tech: 'TaskExecution', biz: '任务执行记录', note: 'Task 的 L2 执行明细' },
  { tech: 'SessionRegistry', biz: '会话档案', note: 'Agent 会话登记表' },
  { tech: 'FlywheelJob', biz: '飞轮作业', note: '飞轮流水线作业记录' },
  { tech: 'FlywheelReflection', biz: '主题反思', note: '跨会话主题聚合反思' },
  { tech: 'AgentRegistry', biz: '智能体名册', note: 'Agent 注册表' },
  { tech: 'KnowledgeCandidate', biz: '知识候选', note: '待验证的知识条目' },
  { tech: 'MemoryCandidate', biz: '记忆候选', note: '待验证的记忆条目' },
  { tech: 'structuredFindings', biz: '结构化发现', note: '反思里的结构化问题清单' },
  { tech: 'TaskStateTransition', biz: '任务状态流转' },
  { tech: 'FlywheelEvent', biz: '飞轮事件' },
  { tech: 'Reflection', biz: '反思' },

  // —— 协议 / 缩写 ——
  { tech: 'MCP', biz: '工具服务', note: '外部工具接入协议, 保留 MCP 作为括号注释' },
  { tech: 'RBAC', biz: '角色权限', note: '基于角色的访问控制' },
  { tech: 'SSO', biz: '单点登录' },
  { tech: 'OAuth', biz: '授权登录' },
  { tech: 'LDAP', biz: '目录账号' },
  { tech: 'API', biz: '接口' },
  { tech: 'api', biz: '接口' },
  { tech: 'tRPC', biz: '内部接口' },
  { tech: 'REST', biz: '服务接口' },
  { tech: 'Webhook', biz: '回调通知' },
  { tech: 'endpoint', biz: '接口地址' },
  { tech: 'Endpoint', biz: '接口地址' },
  { tech: 'Schema', biz: '数据模型' },
  { tech: 'Cron', biz: '定时任务' },
  { tech: 'cron', biz: '定时任务' },
  { tech: 'Job', biz: '作业' },
  { tech: 'job', biz: '作业' },
  { tech: 'DB', biz: '数据库' },
  { tech: 'UI', biz: '界面' },
  { tech: 'Pipeline', biz: '流水线' },
  { tech: 'Dashboard', biz: '看板' },
  { tech: 'dashboard', biz: '看板' },
  { tech: 'Prompt', biz: '提示词' },
  { tech: 'prompt', biz: '提示词' },
  { tech: 'scope', biz: '统计范围' },
  { tech: 'Scope', biz: '统计范围' },
  { tech: 'TODO', biz: '待办' },
  { tech: 'todo', biz: '待办' },

  // —— 通用技术词 ——
  { tech: 'Agent', biz: '智能体', note: '代码标识符仍用 Agent; 界面文案用智能体' },
  { tech: 'agent', biz: '智能体' },
  { tech: 'Session', biz: '会话' },
  { tech: 'session', biz: '会话' },
  { tech: 'Token', biz: '用量（词元）', note: 'Token 计数, 不折算金额' },
  { tech: 'token', biz: '用量（词元）' },
  { tech: 'Memory', biz: '记忆' },
  { tech: 'Knowledge', biz: '知识' },
  { tech: 'Practice', biz: '实践' },
  { tech: 'Skill', biz: '技能' },
  { tech: 'Tool', biz: '工具' },
  { tech: 'MACS', biz: '通信服务', note: 'Agent Chat 平台' },
  { tech: 'macs', biz: '通信服务' },

  // —— 2026-09-14 独立复核增补: 仍是英文/技术口径的可见词 ——
  { tech: 'Coverage', biz: '覆盖度', note: '反思 / 主题的覆盖指标, 不直译 Coverage' },
  { tech: 'coverage', biz: '覆盖度' },
  { tech: 'Resolver', biz: '裁决器', note: '飞轮裁决入库的判定器' },
  { tech: 'sourceType', biz: '来源类型', note: '产物来源分类字段' },
  { tech: 'Topic', biz: '主题' },
  { tech: 'topic', biz: '主题' },
  { tech: 'worker', biz: '执行器', note: '常驻执行进程; "无常驻 worker" -> "无常驻执行器"' },
  { tech: 'finding', biz: '发现' },
  { tech: 'Finding', biz: '发现' },
  { tech: 'Findings', biz: '发现', note: '复数形态, 界面同样说"发现"' },
  { tech: 'qualityScore', biz: '评分', note: '质量分字段, 界面只说"评分"' },
  { tech: 'estimatedTokens', biz: '估算用量', note: '词元估算字段, 不直译 estimatedTokens' },
  { tech: 'combinedTokens', biz: '合计用量', note: '词元合计字段' },
  { tech: 'byAgent', biz: '按智能体', note: '按智能体分组的统计口径' },
  { tech: 'synthesize', biz: '综合生成', note: '反思 / 技能的综合动作' },
  { tech: 'sourceTitle', biz: '来源标题', note: '产物来源标题字段' },
  { tech: 'durationMs', biz: '耗时（毫秒）', note: '耗时字段, 界面用"耗时"并标注单位' },

  // —— 2026-09-15 独立复核缺陷 B 增补: 界面仍有可见的纯英文/漏网技术词 ——
  { tech: 'JSON', biz: '数据', note: '结构化数据格式; 界面说"原始数据"/"输入数据", 不写 JSON' },
  { tech: 'findings', biz: '发现', note: '小写复数形态; 原表只有 finding/Findings, 词边界匹配不到 findings' },
  { tech: 'ID', biz: '编号', note: '标识字段; 界面用"编号"(如 智能体编号 / 任务编号)' },
];

/** 技术词 -> 业务说法 的运行时映射 (由对照表派生, 单一事实源) */
export const TERM_MAP: Record<string, string> = Object.fromEntries(
  TERM_GLOSSARY.map((e) => [e.tech, e.biz])
);

/**
 * 单个术语业务化: 命中对照表则返回业务说法, 否则原样返回。
 * 用于动态枚举/后端返回值的展示层归一。
 */
export function bizTerm(term: string | null | undefined): string {
  if (term == null) return '';
  return TERM_MAP[term] ?? term;
}

/**
 * 文本级业务化: 按**词边界**替换技术词, 避免误伤 (如 "MySQL" 里的 SQL 不动)。
 * 用于接口/日志等自由文本的兜底展示。
 */
export function bizText(text: string | null | undefined): string {
  if (text == null) return '';
  let out = String(text);
  // 长词优先, 避免 Session 被 session 规则先吃掉
  const entries = [...TERM_GLOSSARY].sort((a, b) => b.tech.length - a.tech.length);
  for (const { tech, biz } of entries) {
    const escaped = tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'), biz);
  }
  return out;
}
