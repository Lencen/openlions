"use client";
// 2026-09-10 追加: 通用"转成待办"按钮 (TODO 一等实体)
// 用在讨论发言 / 任务详情 / 知识候选等任意对象上, 一键把该对象变成人的待办项 (走 POST /api/todos)。
import { useState } from "react";
import { Button, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { createTodo } from "@/lib/todos";
import { truncate } from "@/lib/format";

export interface ConvertToTodoButtonProps {
  title: string;
  detail?: string | null;
  source: string;
  sourceRefId?: string | null;
  ownerType?: "human" | "agent";
  ownerId?: string | null;
  priority?: string;
  label?: string;
  size?: "small" | "middle";
  type?: "link" | "default" | "text";
}

export default function ConvertToTodoButton({
  title,
  detail,
  source,
  sourceRefId,
  ownerType = "human",
  ownerId = null,
  priority = "P2",
  label = "转成待办",
  size = "small",
  type = "link",
}: ConvertToTodoButtonProps) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "err">("idle");
  const [msg, setMsg] = useState("");
  const [id, setId] = useState<string | null>(null);

  const run = async () => {
    setState("busy");
    const r = await createTodo({
      title: truncate(title, 200),
      detail: detail || null,
      source,
      sourceRefId: sourceRefId || null,
      ownerType,
      ownerId,
      priority,
    });
    if (r.ok) {
      setState("done");
      setId(r.todo?.id ?? null);
    } else {
      setState("err");
      setMsg(r.error || "创建失败");
    }
  };

  if (state === "done") {
    return (
      <Tooltip title={`已创建待办 ${id || ""} (人类待办, 不计入改进任务)`}>
        <a href="/todo" style={{ fontSize: "var(--fs-sm)", color: "var(--status-ok)", textDecoration: "none" }}>✅ 已建单 →</a>
      </Tooltip>
    );
  }

  return (
    <Tooltip title={state === "err" ? msg : `把这条转成人的待办项 (source=${source})`}>
      <Button
        size={size}
        type={type}
        loading={state === "busy"}
        danger={state === "err"}
        style={type === "link" ? { padding: 0, fontSize: "var(--fs-sm)" } : undefined}
        onClick={run}
      >
        {state === "err" ? "重试建单" : label}
      </Button>
    </Tooltip>
  );
}
