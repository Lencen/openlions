// 2026-10-25 R3：统一线性图标（无第三方依赖）
// 背景：整改前 chrome 区有 329 处 emoji（侧栏/卡片/按钮/状态），跨平台渲染不一致、
//   大小不可控、彩色抢焦点，是「内部工具」气息的最大来源（评审 §3-4）。
// 约束：stroke 走 currentColor，尺寸只允许 14/16/18/20（默认 16），不写 fill。
// 未知名字返回 null（调用方可回退），保证灰度期不炸。
"use client";
import type { CSSProperties } from "react";

export type IconName =
  | "compass" | "dashboard" | "calendar" | "check-square" | "message-square"
  | "radio" | "mail" | "folder" | "folder-open" | "git-branch" | "bot"
  | "activity" | "plug" | "shield-check" | "shield" | "wrench" | "rocket"
  | "refresh" | "rotate" | "building" | "cpu" | "package" | "book"
  | "message-dots" | "target" | "sprout" | "bar-chart" | "banknote"
  | "settings" | "lightbulb" | "search" | "trending-up" | "clipboard"
  | "file-text" | "store" | "puzzle" | "lock" | "heart" | "cone"
  | "coins" | "eye" | "key" | "users" | "server" | "inbox" | "flame" | "x" | "check" | "alert" | "arrow-right";

const P: Record<IconName, string> = {
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.6 5.4L8 16l2.6-5.4z"/>',
  dashboard: '<rect x="3" y="3" width="7.5" height="9" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.5"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.5"/><rect x="3" y="15" width="7.5" height="6" rx="1.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
  "check-square": '<path d="M9 11.5 11.5 14 16 8.5"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  "message-square": '<path d="M21 11.5a8 8 0 0 1-11.6 7.1L4 21l2.4-6.6A8 8 0 1 1 21 11.5z"/>',
  radio: '<circle cx="12" cy="12" r="2.2"/><path d="M8.6 8.6a4.8 4.8 0 0 0 0 6.8M15.4 15.4a4.8 4.8 0 0 0 0-6.8"/><path d="M5.8 5.8a8.8 8.8 0 0 0 0 12.4M18.2 18.2a8.8 8.8 0 0 0 0-12.4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  folder: '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6l2 2H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  "folder-open": '<path d="M3 8.5A2 2 0 0 1 5 6.5h3.6l2 2H19a2 2 0 0 1 2 2v1H6l-3 6.5z"/><path d="m6 11.5-3 6.5h14.5a2 2 0 0 0 1.9-1.4l1.6-5.1"/>',
  "git-branch": '<circle cx="6.5" cy="6" r="2.2"/><circle cx="6.5" cy="18" r="2.2"/><circle cx="17.5" cy="9" r="2.2"/><path d="M6.5 8.2v7.6M17.5 11.2v1.3a3.5 3.5 0 0 1-3.5 3.5H8.7"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 4.5V8M9 13h.01M15 13h.01M9.5 16.5h5"/>',
  activity: '<path d="M3 12h3.5l3 8 4-16 3 8H21"/>',
  plug: '<path d="M9 3v6M15 3v6"/><path d="M6.5 9h11v2.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v4"/>',
  "shield-check": '<path d="M12 3.5 19 6v6c0 4-3 7.2-7 8.5-4-1.3-7-4.5-7-8.5V6z"/><path d="m9 12 2.2 2.2L15 10"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4-3 7.2-7 8.5-4-1.3-7-4.5-7-8.5V6z"/>',
  wrench: '<path d="M15.5 3.5a5.5 5.5 0 0 0-4.9 8L4 18.1V20h1.9l6.6-6.6a5.5 5.5 0 0 0 8-4.9l-3.2 3.2-3.1-.4-.4-3.1z"/>',
  rocket: '<path d="M13.5 4.5c3.5-1.5 6 1 4.5 4.5-.8 1.9-4.5 6-4.5 6l-3-3s4.1-3.7 6-4.5"/><path d="M13.5 12.5 11 15l-2-1-1-2 2.5-2.5"/><path d="M8 16c-1.5.5-2 1.5-2.5 3.5 2-.5 3-1 3.5-2.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-13.7-4.6L4 8.5"/><path d="M4 4.5v4h4"/><path d="M4 13a8 8 0 0 0 13.7 4.6L20 15.5"/><path d="M20 19.5v-4h-4"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
  building: '<rect x="4" y="4" width="16" height="17" rx="1.5"/><path d="M8 8h2M14 8h2M8 12h2M14 12h2M8 16h2M14 16h2"/><path d="M10 21v-3h4v3"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/>',
  package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5"/><path d="M12 12v9"/>',
  book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H19v3H6.5A1.5 1.5 0 0 1 5 19.5z"/>',
  "message-dots": '<path d="M21 11.5a8 8 0 0 1-11.6 7.1L4 21l2.4-6.6A8 8 0 1 1 21 11.5z"/><path d="M9 11h.01M12 11h.01M15 11h.01"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  sprout: '<path d="M12 21v-7"/><path d="M12 14c-4.5 0-6-2.5-6-6 4.5 0 6 2.5 6 6z"/><path d="M12 14c4.5 0 6-2.5 6-6-4.5 0-6 2.5-6 6z"/>',
  "bar-chart": '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  banknote: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 12 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 11a2 2 0 1 1 0 4z"/>',
  lightbulb: '<path d="M9 17.5h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2v.6h5v-.6c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  "trending-up": '<path d="m3 17 6-6 4 4 7-7"/><path d="M15 8h5v5"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M9 10h6M9 14h4"/>',
  "file-text": '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M13.5 3v5.5H19"/><path d="M9 13h6M9 17h4"/>',
  store: '<path d="M4 9.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19V9.5"/><path d="M3 9.5 5 4h14l2 5.5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/>',
  puzzle: '<path d="M10 4.5a2 2 0 1 1 4 0V6h3a1.5 1.5 0 0 1 1.5 1.5V11h1.5a2 2 0 1 1 0 4H18.5v3.5A1.5 1.5 0 0 1 17 20h-3.5v-1.5a2 2 0 1 0-4 0V20H6a1.5 1.5 0 0 1-1.5-1.5V15H6a2 2 0 1 1 0-4H4.5V7.5A1.5 1.5 0 0 1 6 6h4z"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.3A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7 3.2C19 15.6 12 20 12 20z"/>',
  cone: '<path d="M10 4.5h4l5 15H5z"/><path d="M8.4 12h7.2M7 16.5h10"/>',
  coins: '<ellipse cx="9" cy="7.5" rx="5.5" ry="2.5"/><path d="M3.5 7.5v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-4"/><path d="M9 14.5v3c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-4"/><ellipse cx="14.5" cy="11.5" rx="5.5" ry="2.5"/>',
  eye: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  key: '<circle cx="8" cy="8" r="4.5"/><path d="m11.2 11.2 8.3 8.3M16.5 16.5l2-2M19 19l1.5-1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 5.6M17.5 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  server: '<rect x="3" y="4" width="18" height="6.5" rx="1.8"/><rect x="3" y="13.5" width="18" height="6.5" rx="1.8"/><path d="M7 7.2h.01M7 16.7h.01"/>',
  inbox: '<path d="M3 12.5 5.4 5A2 2 0 0 1 7.3 3.5h9.4A2 2 0 0 1 18.6 5L21 12.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 12.5h5l1.5 3h5l1.5-3h5"/>',
  flame: '<path d="M12 21c3.3 0 6-2.4 6-5.5 0-4.2-6-11.5-6-11.5S6 11.3 6 15.5C6 18.6 8.7 21 12 21z"/><path d="M12 17.5a2 2 0 0 0 2-2c0-1.6-2-4-2-4s-2 2.4-2 4a2 2 0 0 0 2 2z"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m4.5 12.5 5 5L20 7"/>',
  alert: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 16.8h.01"/>',
  "arrow-right": '<path d="M4 12h15M13.5 6.5 20 12l-6.5 5.5"/>',
};

/** 旧 emoji（灰度期兼容）：调用方还在传 emoji 时按此表映射。 */
const LEGACY: Record<string, IconName> = {
  "🧭": "compass", "📊": "dashboard", "📅": "calendar", "✅": "check-square",
  "💬": "message-square", "📡": "radio", "✉️": "mail", "✉": "mail",
  "🗂️": "folder", "🗂": "folder", "🧵": "git-branch", "🤖": "bot",
  "🔌": "plug", "🛂": "shield-check", "🛠️": "wrench", "🛠": "wrench",
  "🚀": "rocket", "🔄": "refresh", "🏛️": "building", "🏛": "building",
  "🧠": "cpu", "📦": "package", "📚": "book", "💭": "message-dots",
  "🔧": "wrench", "🎯": "target", "🧬": "git-branch", "🌱": "sprout",
  "💸": "banknote", "⚙️": "settings", "⚙": "settings", "🏃": "activity",
  "💡": "lightbulb", "🔍": "search", "📈": "trending-up", "📋": "clipboard",
  "📜": "file-text", "🏢": "building", "🛍️": "store", "🛍": "store",
  "🧩": "puzzle", "🔐": "lock", "🛡️": "shield", "🛡": "shield",
  "❤️": "heart", "❤": "heart", "📝": "file-text", "🌀": "rotate",
  "🚧": "cone", "🪙": "coins", "🕵️": "eye", "🕵": "eye", "🔑": "key",
  "👤": "users", "🟢": "check", "🔴": "alert", "❌": "alert", "✓": "check", "✗": "x",
};

const KNOWN = new Set(Object.keys(P));

export function resolveIcon(name?: string | null): IconName | null {
  if (!name) return null;
  if (KNOWN.has(name)) return name as IconName;
  const mapped = LEGACY[name.trim()];
  return mapped ?? null;
}

export default function Icon({
  name,
  size = 16,
  className,
  style,
  title,
}: {
  name?: string | null;
  size?: 14 | 16 | 18 | 20 | 24;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const key = resolveIcon(name);
  if (!key) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: "none", display: "inline-block", verticalAlign: "-0.15em", ...style }}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      dangerouslySetInnerHTML={
        title
          ? { __html: `<title>${title.replace(/[<>&]/g, "")}</title>${P[key]}` }
          : { __html: P[key] }
      }
    />
  );
}
