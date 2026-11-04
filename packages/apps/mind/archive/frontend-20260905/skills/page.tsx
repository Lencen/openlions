"use client";

import { useState, useEffect } from "react";
import { Card, Table, Tag, Select, Input, Row, Col, Empty, Spin, Button, Modal, Form, message } from "antd";
import { ToolOutlined, PlusOutlined, RiseOutlined } from "@ant-design/icons";
import dynamic from "next/dynamic";
const ReactECharts = dynamic(() => import("echarts-for-react/lib/core"), { ssr: false });
import ReactMarkdown from "react-markdown";
import * as echarts from "echarts/core";
import { RadarChart, BarChart } from "echarts/charts";
import { RadarComponent, TooltipComponent, GridComponent, LegendComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { KPICard } from "@lions/ui";
import { useThemeColors } from "@/hooks/useThemeColors";

echarts.use([RadarChart, BarChart, RadarComponent, TooltipComponent, GridComponent, LegendComponent, CanvasRenderer]);

interface ToolProf {
  toolName: string;
  proficiency: string;
}

interface SkillItem {
  id: string;
  name: string;
  category: string;
  level: string;
  description: string | null;
  content: string | null;
  totalUsageCount: number;
  selfAssessment: number | null;
  toolProficiency: ToolProf[];
  source: string | null;
  usageMethod: string | null;
  autoMatchRules: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RadarItem {
  category: string;
  count: number;
  levels: Record<string, number>;
  maturityScore: number;
}

interface UpgradeCandidate {
  id: string;
  name: string;
  level: string;
  usagePercent: number;
  nextLevelLabel: string;
  levelColor: string;
  selfAssessment: number | null;
  nextLevel: string | null;
}

interface UpgradeOverview {
  totalUpgradeable: number;
  readyNow: number;
  almostThere: number;
  byLevel: Record<string, { total: number; ready: number; almost: number }>;
}

export default function SkillsPage() {
  const C = useThemeColors();
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [radarData, setRadarData] = useState<RadarItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>();
  const [levelFilter, setLevelFilter] = useState<string | undefined>();
  const [sourceFilter, setSourceFilter] = useState<string | undefined>();
  const [hideEmpty, setHideEmpty] = useState(true);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<SkillItem | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeOverview, setUpgradeOverview] = useState<UpgradeOverview | null>(null);
  const [form] = Form.useForm();

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/trpc/skills.list?input=" + encodeURIComponent(JSON.stringify({ sortBy: "updatedAt", sortOrder: "desc" }))).then((r) => r.json()),
      fetch("/api/trpc/skills.getRadarData").then((r) => r.json()),
      fetch("/api/trpc/skills.getUpgradeOverview").then((r) => r.json()),
    ])
      .then(([listJson, radarJson, overviewJson]) => {
        setSkills(listJson.result?.data ?? []);
        setRadarData(radarJson.result?.data ?? []);
        setUpgradeOverview(overviewJson.result?.data ?? null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async (values: { name: string; category: string; level?: string; description?: string }) => {
    try {
      const res = await fetch("/api/trpc/skills.create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (json.result) {
        message.success("技能已创建");
        setCreateOpen(false);
        form.resetFields();
        fetchData();
      }
    } catch {
      message.error("创建失败");
    }
  };

  const handleUpdateLevel = async (id: string, newLevel: string) => {
    try {
      await fetch("/api/trpc/skills.updateLevel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, level: newLevel }),
      });
      message.success(`等级已更新为 ${newLevel}`);
      fetchData();
    } catch {
      message.error("更新失败");
    }
  };

  const levelColor = (level: string) => {
    const map: Record<string, string> = { "专家": "red", "高级": "orange", "中级": "blue", "初级": "cyan", "感知": "default" };
    return map[level] ?? "default";
  };

  const levelLabel: Record<string, string> = {
    EXPERT: "专家", ADVANCED: "高级", INTERMEDIATE: "中级", BEGINNER: "初级", AWARENESS: "感知",
  };

  const levelNext = (level: string) => {
    const order = ["AWARENESS", "BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"];
    const idx = order.indexOf(level);
    return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  };

  const categories = Array.from(new Set(skills.map((s) => s.category)));
  const filtered = skills.filter((s) => {
    if (categoryFilter && s.category !== categoryFilter) return false;
    if (levelFilter && s.level !== levelFilter) return false;
    if (sourceFilter && s.source !== sourceFilter) return false;
    if (hideEmpty && (!s.content || s.content.trim().length === 0)) return false;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // 雷达图 — 技能成熟度 (用 useThemeColors hook 拿到真实色, 不用 CSS var 字符串)
  const radarOption = radarData.length > 0 ? {
    backgroundColor: "transparent",
    tooltip: { trigger: "item", backgroundColor: C.surfaceHi, borderColor: C.borderHi, textStyle: { color: C.inkPrimary } },
    radar: {
      indicator: radarData.map((r) => ({
        name: r.category.length > 8 ? r.category.slice(0, 8) + ".." : r.category,
        max: 5,
      })),
      shape: "polygon",
      axisName: { color: C.inkTertiary, fontSize: 11 },
      splitArea: { areaStyle: { color: [C.surface, C.surfaceHi] } },
      splitLine: { lineStyle: { color: C.borderSoft } },
      axisLine: { lineStyle: { color: C.borderSoft } },
    },
    series: [{
      type: "radar",
      data: [{
        value: radarData.map((r) => r.maturityScore),
        name: "技能成熟度",
        symbolSize: 8,
        areaStyle: { color: C.brandMind + "40" },  // 25% 透明度
        lineStyle: { color: C.brandMind, width: 2 },
        itemStyle: { color: C.brandMind },
      }],
    }],
  } : null;

  // 等级堆叠
  const levelDistribution = radarData.map((r) => ({ category: r.category, ...r.levels }));

  const levelChartOption = levelDistribution.length > 0 ? {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: C.surfaceHi, borderColor: C.borderHi, textStyle: { color: C.inkPrimary } },
    legend: { show: false },
    grid: { left: 4, right: 4, top: 8, bottom: 4, containLabel: true },
    xAxis: { show: false },
    yAxis: {
      type: "category",
      data: radarData.map((r) => r.category.length > 6 ? r.category.slice(0, 6) + ".." : r.category),
      axisLabel: { color: C.inkTertiary, fontSize: 10 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "中级以上",
        type: "bar",
        stack: "total",
        data: radarData.map((r) => (r.levels?.EXPERT || 0) + (r.levels?.ADVANCED || 0) + (r.levels?.INTERMEDIATE || 0)),
        itemStyle: { color: C.brandMind, borderRadius: [0, 0, 0, 0] },
        barMaxWidth: 14,
      },
      {
        name: "初级以下",
        type: "bar",
        stack: "total",
        data: radarData.map((r) => (r.levels?.BEGINNER || 0) + (r.levels?.AWARENESS || 0)),
        itemStyle: { color: C.brandAxon, borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 14,
      },
    ],
  } : null;

  const fmtTime = (v: string) => v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
  const columns = [
    { title: "技能", dataIndex: "name", key: "name", sorter: (a: SkillItem, b: SkillItem) => a.name.localeCompare(b.name), render: (v: string) => <span style={{ color: "var(--ink-primary)", fontWeight: 500, cursor: "pointer" }}>{v}</span> },
    { title: "内容", key: "hasContent", width: 50, render: (_: unknown, r: SkillItem) => r.content && r.content.trim() ? <Tag color="green" style={{ fontSize: 10 }}>有</Tag> : <Tag style={{ fontSize: 10 }}>空</Tag> },
    { title: "分类", dataIndex: "category", key: "category", width: 120, sorter: (a: SkillItem, b: SkillItem) => a.category.localeCompare(b.category), render: (v: string) => <Tag color="geekblue">{v}</Tag> },
    { title: "来源", dataIndex: "source", key: "source", width: 80, sorter: (a: SkillItem, b: SkillItem) => (a.source ?? "").localeCompare(b.source ?? ""), render: (v: string) => (
      <Tag color={v === "IMPORTED" ? "purple" : "green"}>{v === "IMPORTED" ? "外部引入" : "学习获得"}</Tag>
    )},
    { title: "等级", dataIndex: "level", key: "level", width: 110, sorter: (a: SkillItem, b: SkillItem) => a.level.localeCompare(b.level), render: (v: string, record: SkillItem) => {
      const next = levelNext(v);
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Tag color={levelColor(levelLabel[v] || v)}>{levelLabel[v] || v}</Tag>
          {next && <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); handleUpdateLevel(record.id, next); }} style={{ color: "var(--brand-mind)", fontSize: 11, padding: 0 }}>升级</Button>}
        </div>
      );
    }},
    { title: "自评", dataIndex: "selfAssessment", key: "selfAssessment", width: 55, sorter: (a: SkillItem, b: SkillItem) => (a.selfAssessment ?? 0) - (b.selfAssessment ?? 0), render: (v: number | null) => v ? `${v}/10` : "-" },
    { title: "使用", dataIndex: "totalUsageCount", key: "totalUsageCount", width: 55, sorter: (a: SkillItem, b: SkillItem) => a.totalUsageCount - b.totalUsageCount },
    { title: "创建时间", dataIndex: "createdAt", key: "createdAt", width: 120, sorter: (a: SkillItem, b: SkillItem) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(), render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{fmtTime(v)}</span> },
    { title: "更新时间", dataIndex: "updatedAt", key: "updatedAt", width: 120, sorter: (a: SkillItem, b: SkillItem) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(), defaultSortOrder: "descend" as const, render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{fmtTime(v)}</span> },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: "var(--ink-primary)" }}><ToolOutlined style={{ marginRight: 8 }} />技能与工具</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {upgradeOverview && (upgradeOverview.readyNow > 0 || upgradeOverview.almostThere > 0) && (
            <Button icon={<RiseOutlined />} onClick={() => setUpgradeOpen(true)}>
              提升计划 {upgradeOverview.readyNow > 0 && <Tag color="red" style={{ marginLeft: 4 }}>{upgradeOverview.readyNow}</Tag>}
            </Button>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建技能</Button>
        </div>
      </div>

      {/* 4 KPI — KPICard 改造 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}><KPICard label="技能总数" value={skills.length} tone="mind" size="sm" /></Col>
        <Col xs={12} sm={6}><KPICard label="专家级" value={skills.filter((s) => s.level === "EXPERT").length} tone="err" size="sm" /></Col>
        <Col xs={12} sm={6}><KPICard label="高级" value={skills.filter((s) => s.level === "ADVANCED").length} tone="warn" size="sm" /></Col>
        <Col xs={12} sm={6}><KPICard label="中级" value={skills.filter((s) => s.level === "INTERMEDIATE").length} tone="flow" size="sm" /></Col>
      </Row>

      {radarOption && (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={24} md={12}>
            <Card size="small" title="技能成熟度雷达">
              <ReactECharts echarts={echarts} option={radarOption} style={{ height: 280 }} />
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card size="small" title="等级分布堆叠图">
              <ReactECharts echarts={echarts} option={levelChartOption} style={{ height: 280 }} />
            </Card>
          </Col>
        </Row>
      )}

      <div style={{ marginBottom: 16, display: "flex", gap: 12 }}>
        <Select placeholder="分类" allowClear style={{ width: 140 }} onChange={(v) => setCategoryFilter(v)}
          options={categories.map((c) => ({ label: `${c} (${skills.filter(s => s.category === c).length})`, value: c }))} />
        <Select placeholder="等级" allowClear style={{ width: 120 }} onChange={(v) => setLevelFilter(v)}
          options={["EXPERT", "ADVANCED", "INTERMEDIATE", "BEGINNER", "AWARENESS"].map((l) => ({ label: levelLabel[l], value: l }))} />
        <Select placeholder="来源" allowClear style={{ width: 120 }} onChange={(v) => setSourceFilter(v)}
          options={[{ label: "外部引入", value: "IMPORTED" }, { label: "学习获得", value: "LEARNED" }]} />
        <Select placeholder="内容" allowClear style={{ width: 100 }} onChange={(v) => setHideEmpty(v !== false)}
          options={[{ label: "有内容", value: true }, { label: "全部", value: false }]} value={hideEmpty ? true : undefined} />
        <Input.Search placeholder="搜索技能..." style={{ width: 200 }} onSearch={(v) => setSearch(v)} allowClear />
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", height: 200, alignItems: "center" }}><Spin size="large" /></div>
      ) : filtered.length === 0 ? (
        <Empty description="暂无技能数据" />
      ) : (
        <Table
          dataSource={filtered}
          columns={columns}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 20 }}
          onRow={(record) => ({ onClick: () => { setDetailItem(record); setDetailOpen(true); }, style: { cursor: "pointer" } })}
        />
      )}

      <Modal title="新建技能" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="创建" cancelText="取消">
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label="技能名称" rules={[{ required: true }]}>
            <Input placeholder="例如：Kubernetes" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="category" label="分类" rules={[{ required: true }]}>
                <Select options={[
                  { label: "PROGRAMMING_LANGUAGE", value: "PROGRAMMING_LANGUAGE" },
                  { label: "FRAMEWORK", value: "FRAMEWORK" },
                  { label: "TOOL", value: "TOOL" },
                  { label: "DOMAIN", value: "DOMAIN" },
                  { label: "METHODOLOGY", value: "METHODOLOGY" },
                ]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="level" label="等级" initialValue="BEGINNER">
                <Select options={[
                  { label: "AWARENESS", value: "AWARENESS" }, { label: "BEGINNER", value: "BEGINNER" },
                  { label: "INTERMEDIATE", value: "INTERMEDIATE" }, { label: "ADVANCED", value: "ADVANCED" },
                  { label: "EXPERT", value: "EXPERT" },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="技能描述..." />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="技能详情"
        open={detailOpen}
        onCancel={() => { setDetailOpen(false); setDetailItem(null); }}
        footer={null}
        width={720}
        style={{ top: 40 }}
        styles={{ body: { maxHeight: "calc(100vh - 200px)", overflow: "auto" } }}
      >
        {detailItem ? (
          <div>
            <h3 style={{ color: "var(--ink-primary)", marginBottom: 12 }}>{detailItem.name}</h3>
            <div style={{ marginBottom: 16 }}>
              <Tag color="geekblue">{detailItem.category}</Tag>
              <Tag color={levelColor(detailItem.level)}>{detailItem.level}</Tag>
              <Tag color={detailItem.source === "IMPORTED" ? "purple" : "green"}>
                {detailItem.source === "IMPORTED" ? "外部引入" : "学习获得"}
              </Tag>
              {detailItem.selfAssessment && <span style={{ color: "var(--ink-primary)", fontSize: 13, marginLeft: 8 }}>自评: {detailItem.selfAssessment}/10</span>}
            </div>

            {/* Markdown 内容 */}
            {detailItem.content ? (
              <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12, maxHeight: 400, overflow: "auto" }}>
                <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>技能内容</div>
                <div style={{ color: "var(--ink-primary)", fontSize: 13, lineHeight: 1.7 }}>
                  <ReactMarkdown>{detailItem.content}</ReactMarkdown>
                </div>
              </div>
            ) : detailItem.description ? (
              <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 4, fontSize: 12 }}>详情</div>
                <p style={{ color: "var(--ink-primary)", fontSize: 13, lineHeight: 1.7, margin: 0, whiteSpace: "pre-wrap" }}>{detailItem.description}</p>
              </div>
            ) : null}

            {/* 自动化匹配规则 */}
            {detailItem.autoMatchRules ? (
              <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>自动化匹配规则</div>
                <div style={{ fontSize: 12 }}>
                  {(() => {
                    try {
                      const rules = JSON.parse(detailItem.autoMatchRules) as Array<{ type: string; pattern: string; description?: string }>;
                      return rules.map((r, i) => (
                        <div key={i} style={{ marginBottom: 6, display: "flex", gap: 6, alignItems: "flex-start" }}>
                          <Tag color="cyan" style={{ fontSize: 10, marginTop: 2 }}>{r.type}</Tag>
                          <div>
                            <div style={{ color: "var(--ink-primary)" }}>{r.pattern}</div>
                            {r.description && <div style={{ color: "var(--ink-tertiary)", fontSize: 11 }}>{r.description}</div>}
                          </div>
                        </div>
                      ));
                    } catch {
                      return <span style={{ color: "var(--status-warn)" }}>规则格式错误</span>;
                    }
                  })()}
                </div>
              </div>
            ) : (
              <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 4, fontSize: 12 }}>自动化匹配规则</div>
                <div style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>暂无自动化匹配规则</div>
              </div>
            )}

            {/* 关联工具 */}
            {detailItem.toolProficiency && detailItem.toolProficiency.length > 0 && (
              <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>关联工具</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {detailItem.toolProficiency.map((t) => (
                    <Tag key={t.toolName} color="purple">{t.toolName}</Tag>
                  ))}
                </div>
              </div>
            )}

            {/* 统计数据 */}
            <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>统计数据</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
                <div><span style={{ color: "var(--ink-tertiary)" }}>使用次数：</span><span style={{ color: "var(--ink-primary)" }}>{detailItem.totalUsageCount} 次</span></div>
                <div><span style={{ color: "var(--ink-tertiary)" }}>当前等级：</span><span style={{ color: "var(--ink-primary)" }}>{detailItem.level}</span></div>
                <div><span style={{ color: "var(--ink-tertiary)" }}>自评分数：</span><span style={{ color: "var(--ink-primary)" }}>{detailItem.selfAssessment ?? "-"}/10</span></div>
                <div><span style={{ color: "var(--ink-tertiary)" }}>来源：</span><span style={{ color: "var(--ink-primary)" }}>{detailItem.source === "IMPORTED" ? "外部引入" : "学习获得"}</span></div>
              </div>
            </div>

            {/* 时间信息 */}
            <div style={{ fontSize: 12, color: "var(--ink-tertiary)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <div>创建：{new Date(detailItem.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</div>
              <div>更新：{new Date(detailItem.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</div>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 技能提升计划Modal */}
      <Modal
        title="技能提升计划"
        open={upgradeOpen}
        onCancel={() => setUpgradeOpen(false)}
        footer={null}
        width={700}
        styles={{ body: { maxHeight: "calc(100vh - 200px)", overflow: "auto" } }}
      >
        {upgradeOverview && (
          <div>
            {/* 3 KPI — KPICard 改造 */}
            <Row gutter={[12, 12]} style={{ marginBottom: 20 }}>
              <Col span={6}><KPICard label="可提升" value={upgradeOverview.totalUpgradeable} tone="mind" size="sm" /></Col>
              <Col span={6}><KPICard label="立即提升" value={upgradeOverview.readyNow} tone="err" size="sm" /></Col>
              <Col span={6}><KPICard label="接近目标" value={upgradeOverview.almostThere} tone="warn" size="sm" /></Col>
              <Col span={6}>
                <Button type="primary" icon={<RiseOutlined />} block onClick={async () => {
                  const res = await fetch("/api/trpc/skills.autoUpgrade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minUsagePercent: 80, dryRun: false }) });
                  const json = await res.json();
                  if (json.result?.data?.total > 0) {
                    message.success(`成功提升 ${json.result.data.total} 个技能`);
                    setUpgradeOpen(false);
                    fetchData();
                  } else {
                    message.info("暂无符合自动提升条件的技能");
                  }
                }}>一键自动提升</Button>
              </Col>
            </Row>

            <div style={{ marginBottom: 16, fontWeight: 500, color: "var(--ink-tertiary)" }}>提升候选（使用率 ≥ 50%）</div>
            <Table
              size="small"
              pagination={{ pageSize: 8 }}
              dataSource={(() => {
                const maxUsage: Record<string, number> = { EXPERT: 500, ADVANCED: 300, INTERMEDIATE: 200, BEGINNER: 100, AWARENESS: 50 };
                const nextLevel: Record<string, string> = { AWARENESS: "初级", BEGINNER: "中级", INTERMEDIATE: "高级", ADVANCED: "专家" };
                const levelColorMap: Record<string, string> = { "专家": "red", "高级": "orange", "中级": "blue", "初级": "cyan" };
                const nextLevelMap: Record<string, string | null> = { AWARENESS: "BEGINNER", BEGINNER: "INTERMEDIATE", INTERMEDIATE: "ADVANCED", ADVANCED: "EXPERT", EXPERT: null };
                const candidates: UpgradeCandidate[] = skills.filter(s => s.level !== "EXPERT").map(s => {
                  const max = maxUsage[s.level] ?? 100;
                  const pct = Math.round((s.totalUsageCount / max) * 100);
                  return { id: s.id, name: s.name, level: s.level, selfAssessment: s.selfAssessment, usagePercent: pct, nextLevelLabel: nextLevel[s.level] ?? "", levelColor: levelColorMap[nextLevel[s.level] ?? ""] ?? "default", nextLevel: nextLevelMap[s.level] };
                }).filter(s => s.usagePercent >= 50).sort((a, b) => b.usagePercent - a.usagePercent);
                return candidates;
              })()}
              columns={[
                { title: "技能", dataIndex: "name", key: "name", render: (v: string) => <span style={{ color: "var(--ink-primary)" }}>{v}</span> },
                { title: "当前等级", dataIndex: "level", key: "level", width: 80, render: (v: string) => <Tag color={levelColor(levelLabel[v] || v)}>{levelLabel[v] || v}</Tag> },
                { title: "目标", dataIndex: "nextLevelLabel", key: "next", width: 80, render: (v: string, r: UpgradeCandidate) => v ? <Tag color={r.levelColor}>{v}</Tag> : <span style={{ color: "var(--ink-tertiary)" }}>-</span> },
                { title: "使用率", dataIndex: "usagePercent", key: "pct", width: 80, render: (v: number) => <span style={{ color: v >= 80 ? "var(--status-err)" : v >= 50 ? "var(--status-warn)" : "var(--ink-primary)" }}>{v}%</span> },
                { title: "自评", dataIndex: "selfAssessment", key: "sa", width: 60, render: (v: number | null) => v ? `${v}/10` : "-" },
                { title: "操作", key: "op", width: 80, render: (_: unknown, r: UpgradeCandidate) => r.nextLevel ? (
                  <Button size="small" type="link" onClick={async () => {
                    const targetLevel = r.nextLevel;
                    if (!targetLevel) return;
                    await fetch("/api/trpc/skills.applyUpgradePlan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skillId: r.id, targetLevel }) });
                    message.success(`${r.name} 已提升至 ${r.nextLevelLabel}`);
                    fetchData();
                  }}>提升</Button>
                ) : null },
              ]}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
