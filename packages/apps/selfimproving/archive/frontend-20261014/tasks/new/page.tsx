"use client";
import { useState } from "react";
import { api } from "@/lib/trpc";
import { useRouter } from "next/navigation";

export default function NewTaskPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    title: "",
    description: "",
    background: "",
    requirements: "",
    materials: "",
    acceptanceCriteria: "",
    qualityStandards: "",
    priority: "P2",
    estimatedEffort: "",
  });
  const [creating, setCreating] = useState(false);

  const createTask = api.task.create.useMutation({
    onSuccess: (task) => {
      router.push(`/tasks/${task.id}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    createTask.mutate(form as typeof form & { priority?: string; estimatedEffort?: string });
  };

  const field = (key: keyof typeof form, label: string, placeholder: string, rows = 3) => (
    <div key={key} style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#8b949e", marginBottom: 6 }}>
        {label}
      </label>
      <textarea
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={placeholder}
        rows={rows}
        style={inputStyle}
      />
    </div>
  );

  return (
    <div style={{ padding: "24px", maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f0a500", marginBottom: 24 }}>新建任务</h1>
      <form onSubmit={handleSubmit}>
        <div style={cardStyle}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#8b949e", marginBottom: 6 }}>标题</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="简短的任务标题"
                required
                style={{ ...inputStyle, height: 40 }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#8b949e", marginBottom: 6 }}>优先级</label>
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
                style={{ ...inputStyle, height: 40 }}
              >
                <option value="P1">P1 — 紧急重要</option>
                <option value="P2">P2 — 计划执行</option>
                <option value="P3">P3 — 有空再做</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#8b949e", marginBottom: 6 }}>预估工时</label>
              <input
                value={form.estimatedEffort}
                onChange={(e) => setForm({ ...form, estimatedEffort: e.target.value })}
                placeholder="如：30分钟、2小时、半天"
                style={{ ...inputStyle, height: 40 }}
              />
            </div>
          </div>
          {field("description", "任务描述", "完整描述任务目标、预期成果 — 任何agent看到能立即知道要做什么")}
          {field("background", "背景", "为什么这个任务存在？来自哪里？解决什么问题？")}
          {field("requirements", "执行要求", "具体执行步骤和要求，按序号列出")}
          {field("materials", "所需材料", "需要的文件、知识、资源")}
          {field("acceptanceCriteria", "验收标准", "如何确认任务完成且正确？至少3条具体标准")}
          {field("qualityStandards", "质量标准", "什么是做得好？质量红线是什么？")}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
          <button
            type="button"
            onClick={() => router.back()}
            style={{ background: "transparent", border: "1px solid #30363d", color: "#8b949e", borderRadius: 6, padding: "10px 20px" }}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={creating}
            style={{ background: "#f0a500", color: "#fff", border: "none", borderRadius: 6, padding: "10px 24px", fontWeight: 600 }}
          >
            {creating ? "创建中…" : "创建任务"}
          </button>
        </div>
      </form>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#161b22",
  border: "1px solid #30363d",
  borderRadius: 8,
  padding: "20px 24px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#0d1117",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "8px 12px",
  color: "#e6edf3",
  fontSize: 14,
  fontFamily: "inherit",
  resize: "vertical",
};