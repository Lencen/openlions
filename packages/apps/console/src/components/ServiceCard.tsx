// 2026-11-05 P2 批2：服务名与呼吸点的颜色从内联 style 改为 data-tone 属性选择器
//   （见 ServiceCard.module.css）。状态只有 ok / crit 两档，文案与取数不变。
import styles from "./ServiceCard.module.css";

interface Props {
  name: string;
  port: number;
  status: "ok" | "crit";
  detail?: string;
}

export default function ServiceCard({ name, port, status, detail }: Props) {
  return (
    <div className="service-card">
      <div>
        <div className={"svc-name " + styles.name} data-tone={status}>{name}</div>
        <div className="svc-port">:{port}{detail ? ` · ${detail}` : ""}</div>
      </div>
      <span className={`status-badge ${status}`}>
        <span className={"pulse-dot " + styles.dot} data-tone={status} />
        {status === "ok" ? "运行中" : "未运行"}
      </span>
    </div>
  );
}
