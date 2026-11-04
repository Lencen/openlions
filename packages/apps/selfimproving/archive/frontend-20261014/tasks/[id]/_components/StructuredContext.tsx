/**
 * V3 StructuredContext — 任务详情页结构化上下文展示
 *
 * 显示 task.structuredContext 字段:
 * - 主题 / actionType / confidence (clusterKey)
 * - 根因分析
 * - 实施计划(LLM 建议)
 * - 验收信号
 * - 源反思(可点开)
 * - 关联记忆 / 知识 / 会话 / 问题
 */

interface RelatedReflection {
  id: string;
  title: string;
  priority?: string;
}

interface StructuredContext {
  clusterKey?: string;
  theme?: string;
  actionType?: string;
  confidence?: number;
  rootCause?: string | null;
  plan?: string[];
  acceptanceSignals?: string[];
  relatedReflections?: RelatedReflection[];
  relatedMemories?: string[];
  relatedKnowledge?: string[];
  relatedSessions?: string[];
  relatedProblems?: string[];
}

interface StructuredContextProps {
  rawContext: string | null;
  sourceReflectionIds?: string | null;
  theme?: string | null;
  contextVersion?: string | null;
}

export function StructuredContext({ rawContext, sourceReflectionIds, theme, contextVersion }: StructuredContextProps) {
  if (!rawContext) return null;

  let ctx: StructuredContext;
  try {
    ctx = JSON.parse(rawContext);
  } catch {
    return null;
  }

  // 只在 V3 任务上显示(有 contextVersion='v3' 或有 clusterKey)
  const isV3 = contextVersion === "v3" || !!ctx.clusterKey;
  if (!isV3) return null;

  const conf = typeof ctx.confidence === "number" ? ctx.confidence : 0;
  const confColor = conf >= 0.7 ? "#3fb950" : conf >= 0.5 ? "#f0a500" : "#8b949e";

  // 主题 chip
  const cardStyle: React.CSSProperties = {
    background: "#161b22",
    border: "1px solid #30363d",
    borderRadius: 8,
    padding: "18px 22px",
    marginTop: 16,
  };
  const sectionTitle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    color: "#8b949e",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
  const labelStyle: React.CSSProperties = {
    display: "inline-block",
    fontSize: 11,
    fontWeight: 700,
    padding: "2px 10px",
    borderRadius: 12,
    marginRight: 8,
  };
  const planItemStyle: React.CSSProperties = {
    fontSize: 13,
    color: "#e6edf3",
    lineHeight: 1.7,
    padding: "4px 0",
    borderBottom: "1px solid #21262d",
  };
  const linkStyle: React.CSSProperties = {
    color: "#58a6ff",
    textDecoration: "none",
    fontFamily: "monospace",
    fontSize: 12,
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#e6edf3" }}>🧠 V3 结构化上下文</span>
          <span style={{ ...labelStyle, background: "#1f6feb22", color: "#58a6ff", border: "1px solid #1f6feb55" }}>v3</span>
        </div>
      </div>

      {/* Cluster 概要 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {ctx.theme && (
          <span style={{ ...labelStyle, background: "#a371f722", color: "#a371f7", border: "1px solid #a371f755" }}>
            主题: {ctx.theme}
          </span>
        )}
        {ctx.actionType && (
          <span style={{ ...labelStyle, background: "#1f6feb22", color: "#58a6ff", border: "1px solid #1f6feb55" }}>
            {ctx.actionType}
          </span>
        )}
        {ctx.clusterKey && (
          <span style={{ ...labelStyle, background: "#30363d", color: "#8b949e", fontFamily: "monospace" }}>
            key: {ctx.clusterKey}
          </span>
        )}
        {typeof conf === "number" && (
          <span style={{ ...labelStyle, background: `${confColor}22`, color: confColor, border: `1px solid ${confColor}55` }}>
            信心 {conf.toFixed(2)}
          </span>
        )}
      </div>

      {/* 根因 */}
      {ctx.rootCause && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionTitle}>根因分析</div>
          <div style={{ fontSize: 13, color: "#e6edf3", lineHeight: 1.7, whiteSpace: "pre-wrap", padding: "8px 12px", background: "#0d1117", borderRadius: 6, borderLeft: "3px solid #f85149" }}>
            {ctx.rootCause}
          </div>
        </div>
      )}

      {/* 实施计划 */}
      {ctx.plan && ctx.plan.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionTitle}>📋 实施计划(LLM 建议 · {ctx.plan.length} 步)</div>
          <div>
            {ctx.plan.map((step, i) => (
              <div key={i} style={planItemStyle}>{step}</div>
            ))}
          </div>
        </div>
      )}

      {/* 验收信号 */}
      {ctx.acceptanceSignals && ctx.acceptanceSignals.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionTitle}>✓ 验收信号</div>
          <div>
            {ctx.acceptanceSignals.map((sig, i) => (
              <div key={i} style={{ fontSize: 12, color: "#3fb950", lineHeight: 1.7, padding: "2px 0" }}>
                {sig}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 源反思 */}
      {ctx.relatedReflections && ctx.relatedReflections.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionTitle}>🔗 源反思 ({ctx.relatedReflections.length})</div>
          <div>
            {ctx.relatedReflections.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
                <span style={{ color: "#8b949e", minWidth: 24 }}>#{i + 1}</span>
                {r.title ? (
                  <span style={{ color: "#e6edf3" }}>{r.title}</span>
                ) : (
                  <span style={{ color: "#8b949e" }}>(无标题)</span>
                )}
                {r.priority && (
                  <span style={{ ...labelStyle, background: r.priority === "P1" ? "#f8514922" : r.priority === "P2" ? "#f0a50022" : "#58a6ff22", color: r.priority === "P1" ? "#f85149" : r.priority === "P2" ? "#f0a500" : "#58a6ff", marginRight: 0 }}>
                    {r.priority}
                  </span>
                )}
                <a href={`http://localhost:3004/cognitive/reflection/detail?id=${r.id}`} target="_blank" rel="noreferrer" style={{ ...linkStyle, marginLeft: "auto" }}>
                  {r.id.slice(0, 12)} →
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 关联资源 */}
      {((ctx.relatedMemories?.length ?? 0) + (ctx.relatedKnowledge?.length ?? 0) + (ctx.relatedSessions?.length ?? 0) + (ctx.relatedProblems?.length ?? 0)) > 0 && (
        <div>
          <div style={sectionTitle}>📦 关联资源</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(ctx.relatedMemories?.length ?? 0) > 0 && (
              <div style={{ fontSize: 12, color: "#e6edf3" }}>
                <span style={{ color: "#8b949e" }}>记忆: </span>
                <span style={{ fontWeight: 700 }}>{ctx.relatedMemories!.length}</span>
                <span style={{ color: "#8b949e" }}> (前 3: {ctx.relatedMemories!.slice(0, 3).join(", ")})</span>
              </div>
            )}
            {(ctx.relatedKnowledge?.length ?? 0) > 0 && (
              <div style={{ fontSize: 12, color: "#e6edf3" }}>
                <span style={{ color: "#8b949e" }}>知识: </span>
                <span style={{ fontWeight: 700 }}>{ctx.relatedKnowledge!.length}</span>
                <span style={{ color: "#8b949e" }}> (前 3: {ctx.relatedKnowledge!.slice(0, 3).join(", ")})</span>
              </div>
            )}
            {(ctx.relatedSessions?.length ?? 0) > 0 && (
              <div style={{ fontSize: 12, color: "#e6edf3" }}>
                <span style={{ color: "#8b949e" }}>会话: </span>
                <span style={{ fontWeight: 700 }}>{ctx.relatedSessions!.length}</span>
                <span style={{ color: "#8b949e" }}> (前 3: {ctx.relatedSessions!.slice(0, 3).join(", ")})</span>
              </div>
            )}
            {(ctx.relatedProblems?.length ?? 0) > 0 && (
              <div style={{ fontSize: 12, color: "#e6edf3" }}>
                <span style={{ color: "#8b949e" }}>问题: </span>
                <span style={{ fontWeight: 700 }}>{ctx.relatedProblems!.length}</span>
                <span style={{ color: "#8b949e" }}> (前 3: {ctx.relatedProblems!.slice(0, 3).join(", ")})</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* sourceReflectionIds 后备显示 */}
      {sourceReflectionIds && (!ctx.relatedReflections || ctx.relatedReflections.length === 0) && (
        <div style={{ marginTop: 8, fontSize: 11, color: "#8b949e" }}>
          源反思 ID: {sourceReflectionIds}
        </div>
      )}
    </div>
  );
}
