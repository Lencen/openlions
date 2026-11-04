"use client";

import { useState, useEffect } from "react";
import {
  Card, Row, Col, Progress, Tag, Empty, Spin, Select, Space,
  Badge, Typography,
} from "antd";
import {
  ReadOutlined, RightOutlined,
} from "@ant-design/icons";
import Link from "next/link";
import { KPICard } from "@lions/ui";

const { Text } = Typography;

interface Milestone {
  id: string;
  title: string;
  order: number;
  status: string;
  completedAt: string | null;
  description?: string | null;
  reflectionPrompt?: string | null;
  resources?: string | null;
}

interface LearningPath {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  difficulty: string | null;
  progress: number;
  status: string;
  totalHours: number | null;
  completedHours: number | null;
  milestones: Milestone[];
}

const CATEGORY_ICONS: Record<string, string> = {
  "AI": "🤖",
  "AI-Agent": "🧠",
  "Frontend": "🎨",
  "Backend": "⚙️",
  "Domain": "📊",
  "Tooling": "🔧",
  "DevOps": "🚀",
};

// 难度 → token 颜色
const DIFFICULTY_COLORS: Record<string, string> = {
  BEGINNER: "var(--status-ok)",
  INTERMEDIATE: "var(--status-warn)",
  ADVANCED: "var(--brand-flow)",
  EXPERT: "var(--status-err)",
};

const STATUS_TAG = (status: string) => {
  const map: Record<string, { color: string; label: string }> = {
    COMPLETED: { color: "green", label: "已完成" },
    IN_PROGRESS: { color: "blue", label: "进行中" },
    PENDING: { color: "default", label: "待开始" },
    ACTIVE: { color: "blue", label: "进行中" },
  };
  const info = map[status] ?? { color: "default", label: status };
  return <Tag color={info.color}>{info.label}</Tag>;
};

function MasonryCard({ path }: { path: LearningPath }) {
  const completed = path.milestones.filter((m) => m.status === "COMPLETED").length;
  const total = path.milestones.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <Link href={`/learning/${path.id}`} style={{ textDecoration: "none" }}>
      <Card
        size="small"
        hoverable
        style={{
          background: "var(--surface-hi)",
          borderLeft: `3px solid var(--brand-flow)`,
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
            <Text strong style={{ color: "var(--ink-primary)", fontSize: 14, lineHeight: 1.3 }}>
              {path.title}
            </Text>
            <RightOutlined style={{ color: "var(--brand-flow)", fontSize: 10, flexShrink: 0, marginTop: 4 }} />
          </div>
          <Space size={4} wrap>
            {path.category && (
              <Tag color="geekblue" style={{ fontSize: 11, margin: 0 }}>
                {CATEGORY_ICONS[path.category] ?? ""} {path.category}
              </Tag>
            )}
            {path.difficulty && (
              <Tag color={DIFFICULTY_COLORS[path.difficulty] ?? "default"} style={{ fontSize: 11, margin: 0 }}>
                {path.difficulty}
              </Tag>
            )}
          </Space>
        </div>

        {/* Description */}
        {path.description && (
          <Text style={{ color: "var(--ink-tertiary)", fontSize: 12, display: "block", marginBottom: 10, lineHeight: 1.5 }}
            ellipsis>
            {path.description}
          </Text>
        )}

        {/* Progress */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <Text style={{ color: "var(--ink-tertiary)", fontSize: 11 }}>里程碑进度</Text>
            <Text style={{ color: "var(--ink-primary)", fontSize: 11 }}>{completed}/{total}</Text>
          </div>
          <Progress percent={pct} size="small" strokeColor="var(--brand-flow)" showInfo={false} />
        </div>

        {/* Milestone preview pills */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {path.milestones.slice(0, 6).map((ms) => (
            <Badge
              key={ms.id}
              status={ms.status === "COMPLETED" ? "success" : ms.status === "IN_PROGRESS" ? "processing" : "default"}
              text={<Text style={{ fontSize: 10, color: ms.status === "COMPLETED" ? "var(--ink-tertiary)" : "var(--ink-primary)" }}>{ms.title.slice(0, 10)}</Text>}
              style={{ marginRight: 4 }}
            />
          ))}
          {path.milestones.length > 6 && (
            <Text style={{ fontSize: 10, color: "var(--brand-flow)" }}>+{path.milestones.length - 6} more</Text>
          )}
        </div>

        {/* Footer */}
        <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {path.totalHours ? (
            <Text style={{ color: "var(--ink-tertiary)", fontSize: 11 }}>{path.totalHours}h total</Text>
          ) : <span />}
          {STATUS_TAG(path.status)}
        </div>
      </Card>
    </Link>
  );
}

function CategoryGroup({ category, paths }: { category: string; paths: LearningPath[] }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <Text style={{ fontSize: 16, color: "var(--brand-flow)", fontWeight: 600 }}>
          {CATEGORY_ICONS[category] ?? "📁"} {category}
        </Text>
        <div style={{ flex: 1, height: 1, background: "linear-gradient(to right, var(--brand-flow), transparent)" }} />
      </div>
      <Row gutter={[16, 16]}>
        {paths.map((path) => (
          <Col xs={24} sm={12} md={8} lg={6} key={path.id}>
            <MasonryCard path={path} />
          </Col>
        ))}
      </Row>
    </div>
  );
}

export default function LearningPage() {
  const [paths, setPaths] = useState<LearningPath[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [difficultyFilter, setDifficultyFilter] = useState<string | null>(null);

  const fetchPaths = () => {
    setLoading(true);
    fetch("/api/trpc/learning.listPaths")
      .then((r) => r.json())
      .then((json) => setPaths(json.result?.data ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchPaths(); }, []);

  // Compute unique categories and difficulties
  const allCategories = Array.from(new Set(paths.map((p) => p.category).filter(Boolean))) as string[];
  const allDifficulties = Array.from(new Set(paths.map((p) => p.difficulty).filter(Boolean))) as string[];

  // Apply filters
  const filtered = paths.filter((p) => {
    if (categoryFilter && p.category !== categoryFilter) return false;
    if (difficultyFilter && p.difficulty !== difficultyFilter) return false;
    return true;
  });

  // Group by category
  const grouped = filtered.reduce<Record<string, LearningPath[]>>((acc, p) => {
    const cat = p.category ?? "Other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(p);
    return acc;
  }, {});

  const totalMilestones = paths.reduce((s, p) => s + p.milestones.length, 0);
  const completedMilestones = paths.reduce((s, p) => s + p.milestones.filter((m) => m.status === "COMPLETED").length, 0);

  return (
    <div style={{ padding: "0 8px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: "var(--ink-primary)" }}>
          <ReadOutlined style={{ marginRight: 8 }} />
          学习路径
        </h1>
        <Link href="/learning/new" style={{ color: "var(--brand-flow)", fontSize: 13 }}>
          + 新建路径
        </Link>
      </div>

      {/* Stats row — KPICard 改造 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}>
          <KPICard label="学习路径" value={paths.length} tone="flow" size="sm" format="raw" />
        </Col>
        <Col xs={12} sm={6}>
          <KPICard label="已完成里程碑" value={completedMilestones} tone="ok" size="sm" format="raw" />
        </Col>
        <Col xs={12} sm={6}>
          <KPICard label="进行中" value={totalMilestones - completedMilestones} tone="warn" size="sm" format="raw" />
        </Col>
        <Col xs={12} sm={6}>
          <KPICard label="分类" value={allCategories.length} tone="mind" size="sm" format="raw" />
        </Col>
      </Row>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <Select
          placeholder="全部分类"
          allowClear
          style={{ width: 160 }}
          size="middle"
          options={allCategories.map((c) => ({ label: `${CATEGORY_ICONS[c] ?? "📁"} ${c}`, value: c }))}
          onChange={(v) => setCategoryFilter(v)}
          dropdownStyle={{ background: "var(--surface-hi)" }}
        />
        <Select
          placeholder="全部难度"
          allowClear
          style={{ width: 160 }}
          size="middle"
          options={allDifficulties.map((d) => ({ label: d, value: d }))}
          onChange={(v) => setDifficultyFilter(v)}
          dropdownStyle={{ background: "var(--surface-hi)" }}
        />
        {(categoryFilter || difficultyFilter) && (
          <a style={{ color: "var(--brand-flow)", alignSelf: "center", fontSize: 13 }} onClick={() => { setCategoryFilter(null); setDifficultyFilter(null); }}>
            清除筛选
          </a>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", height: 300, alignItems: "center" }}>
          <Spin size="large" />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description="暂无学习路径" style={{ marginTop: 80 }} />
      ) : (
        <div>
          {Object.entries(grouped)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([category, catPaths]) => (
              <CategoryGroup key={category} category={category} paths={catPaths} />
            ))}
        </div>
      )}
    </div>
  );
}
