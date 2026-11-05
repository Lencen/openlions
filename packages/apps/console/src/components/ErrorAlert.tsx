"use client";
// 2026-10-15（round 76-EZ，数据展示规范 §2：「**错误态必须给下一步动作**，不要只显示报错文本」）
//   —— 一处实现、全站复用。控制台里大量页面是这样写错误态的:
//       {error && <Alert type="error" message="…加载失败" description={String(error.message)} />}
//     只说了"失败了", 用户**不知道下一步该做什么** ✗。本组件在 Alert 右边固定给一个[重试]。
//   与 ui.tsx 的 ErrorBlock 的区别: ErrorBlock 是**整块状态区**(适合整页失败),
//   本组件是**行内提示条**(适合"页面上有一块数据没取到, 但页面其余部分还能用")。
import { Alert, Button, ReloadOutlined } from "@/components/primitives";
import styles from "./ErrorAlert.module.css";

export default function ErrorAlert({
  title,
  message,
  onRetry,
  extra,
}: {
  /** 一句人话说明哪块没加载出来。 */
  title: string;
  /** 细节（通常是 error.message）。 */
  message?: string;
  /** 重试动作（通常是 useApi 给的 mutate）。不给就只显示提示。 */
  onRetry?: () => void;
  /** 额外动作（如"去看服务状态"的链接）。 */
  extra?: React.ReactNode;
}) {
  return (
    <div className={styles.row}>
      <Alert
        type="error"
        showIcon
        className={styles.alert}
        title={title}
        description={message ? String(message).slice(0, 200) : undefined}
      />
      {extra}
      {onRetry ? (
        <Button size="small" icon={<ReloadOutlined />} onClick={() => onRetry()}>重试</Button>
      ) : null}
    </div>
  );
}
