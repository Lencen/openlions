"use client";
// 2026-10-27：功能授权门（S2 门禁用，不阻塞 S1）。
//
// 三条规则来自 LICENSE-GATE-MATRIX §3：
//   1. **不自己算 license**：只认 BFF `/api/license` 给的 features[].ok，前端不推断版本、不算宽限；
//   2. **未授权不静默放行**：未授权 → 显示原因而不是渲染内容；
//   3. **"未授权"与"授权状态未知"必须分开**：未知时**同样不放行**，但文案要说明这不是没买，
//      否则用户会去找客服买一个他其实已经有的东西。
import { useApi } from "@/lib/api";
import { Skeleton } from "@/components/primitives";
import styles from "./FeatureGate.module.css";

interface Feature {
  key: string;
  ok: boolean;
  reason: string | null;
}

interface LicenseResp {
  ok?: boolean;
  state?: string;
  reason?: string | null;
  daysLeft?: number | null;
  required?: boolean;
  edition?: string | null;
  features?: Feature[];
}

const STATE_LABEL: Record<string, string> = {
  valid: "授权有效",
  expired: "授权已过期",
  grace: "宽限期内",
  invalid: "授权无效",
  missing: "未授权",
  unknown: "授权状态未知",
};

export default function FeatureGate({
  feature,
  label,
  children,
}: {
  /** 与后端 feature key 完全一致（如 security.audit / console.analytics），前端不拼字符串 */
  feature: string;
  /** 业务名，用来说明"哪个功能需要授权" */
  label: string;
  children: React.ReactNode;
}) {
  const { data, loading, error } = useApi<LicenseResp>("/api/license", { pollMs: 60000 });

  if (loading) return <Skeleton paragraph={{ rows: 3 }} />;

  const state = error ? "unknown" : data?.state ?? "unknown";
  const f = data?.features?.find((x) => x.key === feature);
  const unauthorized = error || !f || f.ok !== true;

  if (!unauthorized) return <>{children}</>;

  const unknown = state === "unknown" || !f;
  const stateText = STATE_LABEL[state] ?? "授权状态未知";
  const reason = error ? "授权服务暂时取不到" : f?.reason || (unknown ? "授权服务未返回该功能状态" : "该功能未授权");

  return (
    <div className="panel" role="status">
      <div className="panel-header">
        <div className="panel-title">{label}需要 Pro 授权</div>
      </div>
      <div className={styles.body}>
        <p className={styles.lede}>
          {unknown
            ? "当前无法确认授权状态，因此暂不展示该功能。这不是「未购买」——请稍后刷新；持续如此请联系平台管理员。"
            : "当前授权不含该功能。升级到 Pro 后可查看；已有的核心功能不受影响。"}
        </p>
        <div className={"tiny " + styles.meta}>
          <div>· 状态：{stateText}</div>
          {data?.edition ? <div>· 授权版本：{data.edition}</div> : null}
          {typeof data?.daysLeft === "number" ? <div>· 剩余有效期：{data.daysLeft} 天</div> : null}
          <div>· 原因：{reason}</div>
        </div>
      </div>
    </div>
  );
}
