"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card, Row, Col, Progress, Tag, Empty, Spin, Button,
  Typography, Space, Divider, Popconfirm, message, Tooltip,
  Statistic, Timeline, Input, Select, Badge,
} from "antd";
import {
  ArrowLeftOutlined, CheckOutlined, DeleteOutlined, ReadOutlined,
  ThunderboltOutlined, ToolOutlined, FileTextOutlined, PlayCircleOutlined,
  ClockCircleOutlined, EditOutlined, PlusOutlined, SaveOutlined,
  BookOutlined, ExperimentOutlined, CustomerServiceOutlined,
} from "@ant-design/icons";
import Link from "next/link";
import { useParams } from "next/navigation";
import React from "react";

const { Text, Title, Paragraph } = Typography;
const { TextArea } = Input;

interface Resource {
  name: string;
  type: string;
  path: string;
}

interface LearningLog {
  id: string;
  type: string;
  content: string;
  duration: number | null;
  createdAt: string;
}

interface LearningSummary {
  id: string;
  learningLog: string | null;
  practiceSummary: string | null;
  skillsGained: string | null;
  toolsMastered: string | null;
  documents: string | null;
  demos: string | null;
}

interface Milestone {
  id: string;
  title: string;
  order: number;
  status: string;
  completedAt: string | null;
  description: string | null;
  reflectionPrompt: string | null;
  resources: string | null;
  learningLogs: LearningLog[];
  learningSummary: LearningSummary | null;
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

function parseJsonArray(val: string | null): string[] {
  if (!val) return [];
  try { return JSON.parse(val); } catch { return []; }
}

function parseResources(val: string | null): Resource[] {
  if (!val) return [];
  try { return JSON.parse(val); } catch { return []; }
}

function trpcMutation(procedure: string, input: unknown) {
  return fetch(`/api/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => r.json());
}

const MILESTONE_STATUS = {
  NOT_STARTED: { color: "#666", label: "未开始", bg: "#f0f0f0" },
  IN_PROGRESS: { color: "#1890ff", label: "学习中", bg: "#e6f7ff" },
  COMPLETED: { color: "#52c41a", label: "已完成", bg: "#f6ffed" },
};

function MilestoneStatusTag({ status }: { status: string }) {
  const info = MILESTONE_STATUS[status as keyof typeof MILESTONE_STATUS] || MILESTONE_STATUS.NOT_STARTED;
  return (
    <Badge count={info.label} style={{ backgroundColor: info.color }} />
  );
}

function ResourceList({ resources }: { resources: Resource[] }) {
  if (!resources || resources.length === 0) return null;
  const typeIcon: Record<string, React.ReactNode> = {
    doc: <FileTextOutlined />,
    tool: <ToolOutlined />,
    skill: <ExperimentOutlined />,
    spec: <BookOutlined />,
  };
  return (
    <div style={{ marginTop: 8 }}>
      <Text style={{ color: "#667eea", fontSize: 11, fontWeight: 600 }}>学习资料：</Text>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        {resources.map((r, i) => (
          <a key={i} href={r.path} target="_blank" rel="noopener noreferrer"
            style={{ color: "#1890ff", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
            {typeIcon[r.type] || <FileTextOutlined />} {r.name}
          </a>
        ))}
      </div>
    </div>
  );
}

function LearningLogsSection({ logs, milestoneId, onRefresh }: {
  logs: LearningLog[];
  milestoneId: string;
  onRefresh: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [logType, setLogType] = useState("LEARNING");
  const [logContent, setLogContent] = useState("");
  const [logDuration, setLogDuration] = useState<number | undefined>();

  const logTypes = {
    LEARNING: { color: "#667eea", icon: <ReadOutlined />, label: "学习" },
    PRACTICE: { color: "#52c41a", icon: <PlayCircleOutlined />, label: "实践" },
    REVIEW: { color: "#faad14", icon: <ClockCircleOutlined />, label: "回顾" },
  };

  const handleAddLog = async () => {
    if (!logContent.trim()) return;
    await trpcMutation("learning.createLog", {
      milestoneId,
      type: logType,
      content: logContent,
      duration: logDuration,
    });
    message.success("学习记录已添加");
    setLogContent("");
    setLogDuration(undefined);
    setShowAdd(false);
    onRefresh();
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Text style={{ color: "#667eea", fontSize: 12, fontWeight: 600 }}>
          <ReadOutlined /> 学习记录 ({logs.length})
        </Text>
        <Button size="small" icon={<PlusOutlined />} onClick={() => setShowAdd(!showAdd)}>
          添加记录
        </Button>
      </div>

      {showAdd && (
        <Card size="small" style={{ background: "#1a1a2e", marginBottom: 8 }}>
          <Space direction="vertical" style={{ width: "100%" }}>
            <Row gutter={8}>
              <Col span={8}>
                <Select value={logType} onChange={setLogType} style={{ width: "100%" }} size="small">
                  <Select.Option value="LEARNING">学习</Select.Option>
                  <Select.Option value="PRACTICE">实践</Select.Option>
                  <Select.Option value="REVIEW">回顾</Select.Option>
                </Select>
              </Col>
              <Col span={8}>
                <Input type="number" placeholder="时长(分钟)" value={logDuration} onChange={e => setLogDuration(Number(e.target.value))} size="small" />
              </Col>
              <Col span={8}>
                <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleAddLog}>保存</Button>
              </Col>
            </Row>
            <TextArea rows={3} placeholder="记录你的学习内容..." value={logContent} onChange={e => setLogContent(e.target.value)} />
          </Space>
        </Card>
      )}

      {logs.length === 0 && !showAdd && (
        <Text style={{ color: "#666", fontSize: 11 }}>暂无学习记录</Text>
      )}

      <Timeline style={{ marginTop: 8 }}>
        {logs.map((log) => {
          const lt = logTypes[log.type as keyof typeof logTypes] || logTypes.LEARNING;
          return (
            <Timeline.Item key={log.id} color={lt.color}>
              <div style={{ background: "#1a1a2e", padding: 8, borderRadius: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <Space size={4}>
                    <Tag color={lt.color} style={{ fontSize: 10, margin: 0 }}>{lt.icon} {lt.label}</Tag>
                    {log.duration && <Text style={{ color: "#a0a0b0", fontSize: 10 }}>{log.duration}分钟</Text>}
                  </Space>
                  <Text style={{ color: "#666", fontSize: 10 }}>
                    {new Date(log.createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}
                  </Text>
                </div>
                <Paragraph style={{ color: "#e8e8e8", fontSize: 12, margin: 0 }}>{log.content}</Paragraph>
              </div>
            </Timeline.Item>
          );
        })}
      </Timeline>
    </div>
  );
}

function SummarySection({ summary, milestoneId, onRefresh }: {
  summary: LearningSummary | null;
  milestoneId: string;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [learningLog, setLearningLog] = useState(summary?.learningLog || "");
  const [practiceSummary, setPracticeSummary] = useState(summary?.practiceSummary || "");
  const [skillsGained, setSkillsGained] = useState<string[]>([]);
  const [toolsMastered, setToolsMastered] = useState<string[]>([]);
  const [documents, setDocuments] = useState<string[]>([]);
  const [demos, setDemos] = useState<string[]>([]);

  useEffect(() => {
    setLearningLog(summary?.learningLog || "");
    setPracticeSummary(summary?.practiceSummary || "");
    setSkillsGained(parseJsonArray(summary?.skillsGained || null));
    setToolsMastered(parseJsonArray(summary?.toolsMastered || null));
    setDocuments(parseJsonArray(summary?.documents || null));
    setDemos(parseJsonArray(summary?.demos || null));
  }, [summary]);

  const handleSave = async () => {
    await trpcMutation("learning.createSummary", {
      milestoneId,
      learningLog,
      practiceSummary,
      skillsGained: JSON.stringify(skillsGained),
      toolsMastered: JSON.stringify(toolsMastered),
      documents: JSON.stringify(documents),
      demos: JSON.stringify(demos),
    });
    message.success("总结已保存");
    setEditing(false);
    onRefresh();
  };

  if (editing) {
    return (
      <Card size="small" style={{ background: "#1a1a2e", marginTop: 12 }}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <div>
            <Text style={{ color: "#667eea", fontSize: 11 }}>学习日志总结：</Text>
            <TextArea rows={3} value={learningLog} onChange={e => setLearningLog(e.target.value)} />
          </div>
          <div>
            <Text style={{ color: "#667eea", fontSize: 11 }}>实践总结：</Text>
            <TextArea rows={3} value={practiceSummary} onChange={e => setPracticeSummary(e.target.value)} />
          </div>
          <div>
            <Text style={{ color: "#667eea", fontSize: 11 }}>掌握的技能（逗号分隔）：</Text>
            <Select mode="tags" value={skillsGained} onChange={setSkillsGained} style={{ width: "100%" }} placeholder="输入技能名称后回车">
            </Select>
          </div>
          <div>
            <Text style={{ color: "#667eea", fontSize: 11 }}>掌握的工具（逗号分隔）：</Text>
            <Select mode="tags" value={toolsMastered} onChange={setToolsMastered} style={{ width: "100%" }} placeholder="输入工具名称后回车">
            </Select>
          </div>
          <div>
            <Text style={{ color: "#667eea", fontSize: 11 }}>文档成果（逗号分隔）：</Text>
            <Select mode="tags" value={documents} onChange={setDocuments} style={{ width: "100%" }} placeholder="输入文档路径或链接">
            </Select>
          </div>
          <div>
            <Text style={{ color: "#667eea", fontSize: 11 }}>Demo演示（逗号分隔）：</Text>
            <Select mode="tags" value={demos} onChange={setDemos} style={{ width: "100%" }} placeholder="输入Demo链接">
            </Select>
          </div>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>保存总结</Button>
        </Space>
      </Card>
    );
  }

  const skills = summary ? parseJsonArray(summary.skillsGained) : [];
  const tools = summary ? parseJsonArray(summary.toolsMastered) : [];
  const docs = summary ? parseJsonArray(summary.documents) : [];
  const demoList = summary ? parseJsonArray(summary.demos) : [];

  const hasAnyContent = learningLog || practiceSummary || skills.length > 0 || tools.length > 0 || docs.length > 0 || demoList.length > 0;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Text style={{ color: "#667eea", fontSize: 12, fontWeight: 600 }}>
          <ThunderboltOutlined /> 学习成果
        </Text>
        <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(true)}>
          {hasAnyContent ? "编辑总结" : "添加总结"}
        </Button>
      </div>

      {!hasAnyContent && (
        <Text style={{ color: "#666", fontSize: 11 }}>暂无学习成果，点击编辑添加</Text>
      )}

      {learningLog && (
        <Card size="small" style={{ background: "#1a1a2e", marginBottom: 8 }}>
          <Text style={{ color: "#667eea", fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>
            <CustomerServiceOutlined /> 学习日志总结
          </Text>
          <Paragraph style={{ color: "#e8e8e8", fontSize: 12 }}>{learningLog}</Paragraph>
        </Card>
      )}

      {practiceSummary && (
        <Card size="small" style={{ background: "#1a1a2e", marginBottom: 8 }}>
          <Text style={{ color: "#667eea", fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>
            <ExperimentOutlined /> 实践总结
          </Text>
          <Paragraph style={{ color: "#e8e8e8", fontSize: 12 }}>{practiceSummary}</Paragraph>
        </Card>
      )}

      {(skills.length > 0 || tools.length > 0 || docs.length > 0 || demoList.length > 0) && (
        <Row gutter={[8, 8]}>
          {skills.length > 0 && (
            <Col span={12}>
              <Card size="small" style={{ background: "#1a1a2e" }}>
                <Text style={{ color: "#667eea", fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>
                  <ThunderboltOutlined /> 掌握的技能
                </Text>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {skills.map((s, i) => (
                    <Tag key={i} color="geekblue" style={{ fontSize: 11 }}>{s}</Tag>
                  ))}
                </div>
              </Card>
            </Col>
          )}
          {tools.length > 0 && (
            <Col span={12}>
              <Card size="small" style={{ background: "#1a1a2e" }}>
                <Text style={{ color: "#667eea", fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>
                  <ToolOutlined /> 掌握的工具
                </Text>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {tools.map((t, i) => (
                    <Tag key={i} color="purple" style={{ fontSize: 11 }}>{t}</Tag>
                  ))}
                </div>
              </Card>
            </Col>
          )}
          {docs.length > 0 && (
            <Col span={12}>
              <Card size="small" style={{ background: "#1a1a2e" }}>
                <Text style={{ color: "#667eea", fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>
                  <FileTextOutlined /> 文档成果
                </Text>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {docs.map((d, i) => (
                    <a key={i} href={d} target="_blank" rel="noopener noreferrer"
                      style={{ color: "#1890ff", fontSize: 11 }}>{d}</a>
                  ))}
                </div>
              </Card>
            </Col>
          )}
          {demoList.length > 0 && (
            <Col span={12}>
              <Card size="small" style={{ background: "#1a1a2e" }}>
                <Text style={{ color: "#667eea", fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>
                  <PlayCircleOutlined /> Demo演示
                </Text>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {demoList.map((d, i) => (
                    <a key={i} href={d} target="_blank" rel="noopener noreferrer"
                      style={{ color: "#1890ff", fontSize: 11 }}>{d}</a>
                  ))}
                </div>
              </Card>
            </Col>
          )}
        </Row>
      )}
    </div>
  );
}

function MilestoneCard({ milestone, onComplete, onDelete, completing }: {
  milestone: Milestone;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  completing: string | null;
}) {
  const resources = parseResources(milestone.resources);

  return (
    <Card
      size="small"
      style={{
        background: milestone.status === "COMPLETED" ? "#1e3a2f" : milestone.status === "IN_PROGRESS" ? "#1e2a45" : "#253356",
        borderLeft: `3px solid ${
          milestone.status === "COMPLETED" ? "#52c41a" :
          milestone.status === "IN_PROGRESS" ? "#1890ff" : "#666"
        }`,
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Text strong style={{ color: "#e8e8e8", fontSize: 14 }}>
              {milestone.order}. {milestone.title}
            </Text>
            <MilestoneStatusTag status={milestone.status} />
          </div>

          {/* Description - 学习内容 */}
          {milestone.description && (
            <div style={{ marginBottom: 8 }}>
              <Text style={{ color: "#667eea", fontSize: 11, fontWeight: 600 }}>学习内容：</Text>
              <Paragraph style={{ color: "#a0a0b0", fontSize: 12, marginTop: 2 }}>{milestone.description}</Paragraph>
            </div>
          )}

          {/* Resources - 学习资料/参考项目 */}
          <ResourceList resources={resources} />

          {milestone.completedAt && (
            <Text style={{ color: "#52c41a", fontSize: 11, marginTop: 8, display: "block" }}>
              完成于 {new Date(milestone.completedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}
            </Text>
          )}
        </div>

        <Space size={4}>
          {milestone.status !== "COMPLETED" && (
            <Tooltip title="标记完成">
              <Button type="text" size="small" icon={<CheckOutlined />}
                loading={completing === milestone.id}
                onClick={() => onComplete(milestone.id)}
                style={{ color: "#52c41a" }}
              />
            </Tooltip>
          )}
          <Popconfirm title="确定删除此里程碑？" onConfirm={() => onDelete(milestone.id)} okText="删除" cancelText="取消">
            <Tooltip title="删除里程碑">
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      </div>

      <Divider style={{ margin: "12px 0", borderColor: "#2a3a5c" }} />

      {/* Learning Logs */}
      <LearningLogsSection
        logs={milestone.learningLogs}
        milestoneId={milestone.id}
        onRefresh={() => {}}
      />

      <Divider style={{ margin: "12px 0", borderColor: "#2a3a5c" }} />

      {/* Summary Section */}
      <SummarySection
        summary={milestone.learningSummary}
        milestoneId={milestone.id}
        onRefresh={() => {}}
      />
    </Card>
  );
}

export default function LearningDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [path, setPath] = useState<LearningPath | null>(null);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState<string | null>(null);

  const fetchPath = useCallback(() => {
    setLoading(true);
    fetch(`/api/trpc/learning.getPath?input=${encodeURIComponent(JSON.stringify(id))}`)
      .then((r) => r.json())
      .then((json) => setPath(json.result?.data ?? null))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { fetchPath(); }, [fetchPath]);

  const handleComplete = async (milestoneId: string) => {
    setCompleting(milestoneId);
    try {
      await trpcMutation("learning.completeMilestone", { milestoneId });
      message.success("里程碑已完成");
      fetchPath();
    } catch {
      message.error("操作失败");
    } finally {
      setCompleting(null);
    }
  };

  const handleDelete = async (milestoneId: string) => {
    await trpcMutation("learning.deleteMilestone", milestoneId);
    message.success("里程碑已删除");
    fetchPath();
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", height: 400, alignItems: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!path) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description="学习路径不存在" />
        <div style={{ marginTop: 16 }}>
          <Link href="/learning">
            <Button icon={<ArrowLeftOutlined />}>返回列表</Button>
          </Link>
        </div>
      </div>
    );
  }

  const completed = path.milestones.filter((m) => m.status === "COMPLETED").length;
  const inProgress = path.milestones.filter((m) => m.status === "IN_PROGRESS").length;
  const total = path.milestones.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div style={{ padding: "0 8px" }}>
      <Link href="/learning" style={{ color: "#667eea", fontSize: 13, display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 16 }}>
        <ArrowLeftOutlined /> 返回学习路径
      </Link>

      <Card style={{ background: "#253356", marginBottom: 24, borderLeft: "3px solid #667eea" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Title level={3} style={{ color: "#e8e8e8", marginBottom: 8 }}>{path.title}</Title>
            <Space size={8} wrap style={{ marginBottom: 12 }}>
              {path.category && <Tag color="geekblue">{path.category}</Tag>}
              {path.difficulty && <Tag color="orange">{path.difficulty}</Tag>}
            </Space>
            {path.description && (
              <Paragraph style={{ color: "#a0a0b0", fontSize: 13, marginBottom: 12 }}>
                {path.description}
              </Paragraph>
            )}
          </div>
          <div style={{ textAlign: "right", minWidth: 120 }}>
            <Statistic title={<Text style={{ color: "#a0a0b0", fontSize: 11 }}>进度</Text>} value={pct} suffix="%" valueStyle={{ color: "#667eea", fontSize: 24 }} />
          </div>
        </div>

        <Row gutter={[16, 8]} style={{ marginTop: 16 }}>
          <Col span={8}><Text style={{ color: "#a0a0b0", fontSize: 11 }}>总里程碑</Text><div><Text style={{ color: "#e8e8e8", fontSize: 16 }}>{total}</Text></div></Col>
          <Col span={8}><Text style={{ color: "#a0a0b0", fontSize: 11 }}>进行中</Text><div><Text style={{ color: "#1890ff", fontSize: 16 }}>{inProgress}</Text></div></Col>
          <Col span={8}><Text style={{ color: "#a0a0b0", fontSize: 11 }}>已完成</Text><div><Text style={{ color: "#52c41a", fontSize: 16 }}>{completed}</Text></div></Col>
        </Row>

        <Progress percent={pct} size="small" strokeColor="#667eea" style={{ marginTop: 12 }} />
      </Card>

      <Title level={5} style={{ color: "#667eea", marginBottom: 16 }}>
        里程碑 ({total})
      </Title>

      {path.milestones.length === 0 ? (
        <Empty description="暂无里程碑" style={{ marginTop: 40 }} />
      ) : (
        <div>
          {path.milestones.map((milestone) => (
            <MilestoneCard
              key={milestone.id}
              milestone={milestone}
              onComplete={handleComplete}
              onDelete={handleDelete}
              completing={completing}
            />
          ))}
        </div>
      )}
    </div>
  );
}