"use client";
// todo 页 · "新建待办" 弹窗 (从 page.tsx 抽出)
// 2026-11-04 P1 收尾：表单布局从内联 style 改为 page.module.css 的类（.formRow / .fullWidth），
//   字段、校验、文案、提交逻辑未改。
import { DatePicker, Form, Input, Modal, Select } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t as tr } from "@/i18n";
import { TODO_SOURCE } from "@/lib/todos";
import styles from "../page.module.css";

export default function TodoCreateModal({
  open,
  onCancel,
  onOk,
  form,
  agents,
}: {
  open: boolean;
  onCancel: () => void;
  onOk: () => void;
  form: any;
  agents: any[];
}) {
  return (
    <Modal
      open={open}
      title="新建待办"
      onCancel={onCancel}
      onOk={onOk}
      okText="创建"
      cancelText="取消"
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ ownerType: "human", priority: "P2", source: "human" }}>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: "请填写标题" }]}>
          <Input placeholder="例: 确认 FW-EXTRACT 提炼器方案范围与优先级（需人类拍板）" />
        </Form.Item>
        <Form.Item name="detail" label="详情"><Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder="背景 / 需要人做什么 / 判断依据" /></Form.Item>
        <div className={styles.formRow}>
          <Form.Item name="ownerType" label="负责人类型">
            <Select options={[{ value: "human", label: tr('todo.owner.human') }, { value: "agent", label: tr('todo.owner.agent') }]} />
          </Form.Item>
          <Form.Item name="ownerId" label={tr('todo.assign')}>
            <Select allowClear showSearch optionFilterProp="label" options={agents} placeholder="不指派" />
          </Form.Item>
        </div>
        <div className={styles.formRow}>
          <Form.Item name="priority" label="优先级">
            <Select options={[{ value: "P0", label: "P0 最高" }, { value: "P1", label: "P1" }, { value: "P2", label: "P2 默认" }]} />
          </Form.Item>
          <Form.Item name="dueAt" label="截止时间">
            <DatePicker showTime className={styles.fullWidth} />
          </Form.Item>
          <Form.Item name="source" label="来源">
            <Select options={Object.entries(TODO_SOURCE).map(([k, v]) => ({ value: k, label: v.label }))} />
          </Form.Item>
        </div>
        <Form.Item name="evidence" label="证据 / 参考 (可选)"><Input placeholder="链接、命令、数据行号等" /></Form.Item>
        {/* 2026-09-11: mind POST 现在接受并落库 meta (commit 99d95c3) —— 高级字段可选填 */}
        <Form.Item
          name="meta"
          label="高级 · 扩展数据（可选）"
          tooltip='机器可读字段, 例如 {"sections":["background","actions","acceptance","context","impact","decision","due"],"taskIds":["<任务id>"],"options":[{"key":"A","label":"...","impact":"..."}],"generatedBy":"human"}'
          rules={[
            {
              validator: (_: any, v: string) => {
                if (!v || !String(v).trim()) return Promise.resolve();
                try { JSON.parse(v); return Promise.resolve(); } catch (e: any) { return Promise.reject(new Error("扩展数据必须是合法的结构化数据：" + String(e?.message || "").slice(0, 60))); }
              },
            },
          ]}
        >
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder='{"sections":[...],"taskIds":[...],"generatedBy":"human"}' />
        </Form.Item>
      </Form>
    </Modal>
  );
}
