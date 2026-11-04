export interface ConversationMessage {
  // P1-B 2026-08-31: 扩展 tool/system 角色 (DSH/openclaw session 含工具消息与系统注入)
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  timestamp?: string;
  toolName?: string;  // tool 消息的工具名
}

export interface ParsedConversation {
  sessionId: string;
  projectPath: string;
  projectName: string;
  title?: string;
  messages: ConversationMessage[];
  messageCount: number;
  startTime?: string;
  endTime?: string;
  filePath: string;
  // 2026-09-01 NETWORK 死端修复: 瞬时错误 FAILED 冷却后重试的会话优先处理
  retryable?: boolean;
}

export interface ExtractedMemory {
  content: string;
  title: string;
  tier: "HOT" | "WARM" | "COLD";
  type: string;
  // 2026-10-07 P4: 可为 null —— Memory.domain 是**可空**的受控枚举列; 类型此前写死 string,
  //   掩盖了"LLM 未产出/不值域"的合法状态, 也逼着写入点编造 "通用" 这类假默认值。
  domain: string | null;
  tags: string;
  valueScore: number;
  theme?: string;
}

export interface ExtractedKnowledge {
  title: string;
  content?: string;               // 老格式正文(可选); 新格式由三要素合成
  // ===== 2026-09-03 陈述式知识三要素 (认知框架: 是什么/为什么/边界) =====
  conclusion?: string;            // 一句话判断/结论: 是什么 / 为什么成立 (必填门槛)
  principle?: string;             // 原理/机制: 为什么 (必填门槛)
  boundary?: string;              // 适用边界/限制: 什么条件下成立/不成立 (必填门槛)
  evidence?: string;              // 事实/依据: 支撑结论的证据或来源
  caseExample?: string;           // 案例: 帮助复述与迁移理解
  category: string;
  tags: string;
  confidence: number;
  theme?: string;
}

export interface ExtractedReflection {
  title: string;
  description: string;
  category: string;
  priority: "P1" | "P2" | "P3";
  lesson: string;
  improvements: string;
  score: number;
  // === V3 新增 ===
  theme?: string;
  actionType?: "CREATE_TASK" | "UPDATE_SKILL" | "ADD_KNOWLEDGE" | "ALERT" | "NONE";
  actionConfidence?: number;
  structuredImprovements?: ExtractedImprovement[];
  relatedRefs?: {
    memories?: string[];
    knowledge?: string[];
    sessions?: string[];
    problems?: string[];
  };
  rootCauseAnalysis?: string;
  proposedPlan?: string;
  processingVersion?: string;
}

export interface ExtractedImprovement {
  text: string;
  severity: "P1" | "P2" | "P3";
  area: string;
}

export interface ExtractedPractice {
  title: string;
  description: string;
  type: string;
  outcome: "SUCCESS" | "PARTIAL" | "FAILED";
  qualityScore: number;
  difficulty: number;
  theme?: string;
}

export interface ExtractedSkill {
  name: string;
  category: string;
  level?: string;       // 2026-08-28 P1.5: LLM 可返回熟练度, 缺省 AWARENESS
  description: string;
  theme?: string | null; // 2026-09-03: 主题聚合提取时回填 (聚合闭环 STEP5 溯源)
  // ===== SKILL-SPEC 2026-08-28 (docs/SKILL-SPEC.md): 无 steps 不成 skill =====
  content: string;      // steps: markdown 编号步骤,含命令
  trigger: string;      // 适用场景
  verification: string; // 验证方法
  pitfalls: string;     // 已知坑 (可选)
}

export interface ExtractedCognitiveData {
  summary: string;
  memories: ExtractedMemory[];
  knowledge: ExtractedKnowledge[];
  reflections: ExtractedReflection[];
  practices: ExtractedPractice[];
  skills: ExtractedSkill[];
  // SKILL-SPEC 2026-08-28: 无步骤"技能"降级为 knowledge, 不丢数据
  knowledgeFromSkills?: ExtractedKnowledge[];
}

export interface PipelineResult {
  conversation: ParsedConversation;
  extracted: ExtractedCognitiveData;
  stats: {
    // === 保留兼容字段: 老消费者仍读这些数字 (= created + updated_reinforced 的和) ===
    memoriesCreated: number;
    knowledgeCreated: number;
    reflectionsCreated: number;
    practicesCreated: number;
    skillsCreated: number;
    flywheelEventsCreated: number;
    // === 2026-07-02 STRUCTURED-V3: Resolver 分派细节 ===
    candidatesCreated?: number;    // resolveCandidate → CREATE 落新正式表
    candidatesUpdated?: number;    // → UPDATE 强化 (reinforceCount+1)
    candidatesMerged?: number;     // → MERGE 标 supersededBy 老记录, 新建取代
    candidatesDiscarded?: number;  // → DISCARD 垃圾丢弃
    // === 2026-09-10 明文补登记 (此前写入未声明, 长期 TS 报错) ===
    memoriesDropped?: number;
    memoryTypesNormalized?: number;
    knowledgeDowngraded?: number;
    knowledgeDropped?: number;
    // === 2026-09-23 uos20 #8 Skills 成功率统计 (轻量版) ===
    // 与 knowledgeCreated/skillsCreated 拆开追踪, 避免聚合字段掩盖 skill 类型为 0。
    // 口径见 skill-success-rate.ts: 生成即成功 + 分母=候选总数, 两位小数 + 原始分子分母。
    skillsDowngraded?: number;       // 无 steps 降级进 knowledge(skill-downgraded) 的候选数
    skillCandidatesTotal?: number;   // 分母 = skillsCreated + skillsDowngraded
    skillSuccessRate?: number | null;    // 0~1, 两位小数; 无候选时 null
    skillSuccessRatePct?: number | null; // 0~100, 两位小数; 无候选时 null
    resolverBreakdown?: {
      memory: { create: number; update: number; merge: number; discard: number };
      knowledge: { create: number; update: number; merge: number; discard: number };
      reflection: { create: number; update: number; merge: number; discard: number };
      practice: { create: number; update: number; merge: number; discard: number };
    };
  };
}

export interface ScanResult {
  totalConversations: number;
  newConversations: ParsedConversation[];
  alreadyProcessed: number;
  projectSummary: Array<{
    projectPath: string;
    projectName: string;
    conversationCount: number;
    newCount: number;
  }>;
}
