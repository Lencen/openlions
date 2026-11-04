"use client";

/**
 * 统一时钟 (BeijingClock)
 *
 * 北京时间, 1s 刷新, 4 模式 SSR 安全
 *  - 初始值硬编码 "" (跟 SSR 一致, 避免 hydration mismatch)
 *  - hydration 后 useEffect 启动 interval
 *  - 跨 mind + task 复用
 */

import { useEffect, useState } from "react";

export interface BeijingClockProps {
  format?: "full" | "date" | "time" | "short";
  size?: "sm" | "md" | "lg";
  showDate?: boolean;
  showTime?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

function formatNow(now: Date, format: "full" | "date" | "time" | "short"): string {
  // 北京时间 (UTC+8) - 使用 Intl.DateTimeFormat 正确处理时区
  const options: Intl.DateTimeFormatOptions = {
    timeZone: "Asia/Shanghai",
    hour12: false,
  };

  if (format === "date") {
    options.year = "numeric";
    options.month = "2-digit";
    options.day = "2-digit";
    return new Intl.DateTimeFormat("zh-CN", options).format(now).replace(/\//g, "-");
  }

  if (format === "time") {
    options.hour = "2-digit";
    options.minute = "2-digit";
    options.second = "2-digit";
    return new Intl.DateTimeFormat("zh-CN", options).format(now);
  }

  if (format === "short") {
    options.hour = "2-digit";
    options.minute = "2-digit";
    return new Intl.DateTimeFormat("zh-CN", options).format(now);
  }

  // full
  options.year = "numeric";
  options.month = "2-digit";
  options.day = "2-digit";
  options.hour = "2-digit";
  options.minute = "2-digit";
  options.second = "2-digit";
  return new Intl.DateTimeFormat("zh-CN", options).format(now).replace(/\//g, "-");
}

export function BeijingClock({
  format = "full",
  size = "md",
  showDate = true,
  showTime = true,
  className = "",
  style,
}: BeijingClockProps) {
  // 初始值硬编码 "" (跟 SSR 一致, hydration 后 useEffect 启动 interval)
  const [text, setText] = useState("");

  useEffect(() => {
    const update = () => setText(formatNow(new Date(), format));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [format]);

  const sizeStyle: React.CSSProperties = {
    sm: { fontSize: "var(--text-sm)" },
    md: { fontSize: "var(--text-md)" },
    lg: { fontSize: "var(--text-lg)", fontWeight: 500 },
  }[size];

  const display =
    text === ""
      ? format === "date"
        ? "----.--.--"
        : format === "time"
        ? "--:--:--"
        : format === "short"
        ? "--:--"
        : "----.--.-- --:--:--"
      : text;

  return (
    <span
      className={`clock ${size === "lg" ? "clock-lg" : ""} ${className}`}
      style={{
        ...sizeStyle,
        fontFeatureSettings: '"tnum" 1',
        letterSpacing: "0.05em",
        ...style,
      }}
    >
      {display}
    </span>
  );
}
