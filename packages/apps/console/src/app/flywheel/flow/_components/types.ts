// flywheel/flow 页 · 数据类型 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
export interface Step { id: string; label: string; desc: string; color: string; qty: { m5: number; m15: number; h1: number; h24: number }; }
export interface FlowData {
  heartbeat: {
    lastEvent: { stage: string; sourceType: string; title: string; createdAt: number; ageSec: number } | null;
    running: any[]; runningTheme: any[]; llm24: number;
  };
  steps: Step[];
  sources: Array<{ source: string; events: number }>;
  sessByAgent: Array<{ agentId: string; total: number; pendingN: number; doneN: number; failedN: number }>;
  recentProcessed: Array<{ agentId: string; sessionUid: string; messageCount: number; t: string }>;
  queues: Record<string, number>;
  quality: Record<string, { n: number; scored: number; unscored: number; avgQ: number; highQ: number; lowQ: number }>;
  resolver: Array<{ action: string; c: number }>;
  reflectStatus: Array<{ status: string; c: number }>;
  qualityAudit?: { at: string; ageHours: number; violations: number; targetStage: string; failed: string[]; observations: Record<string, number>; scorecard?: { cov: number | null; covTrend: number | null; landedRate: number | null; needsReview: number; taskDoneRate: number | null; pendingNow: number; prod: string[] } | null } | null;
  errToday: Array<{ errorType: string; c: number }>;
  logs: string[];
  timestamp: string;
}
