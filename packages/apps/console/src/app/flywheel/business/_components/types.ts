// 飞轮业务看板：快照/接口的最小类型。业务扩展字段是 v1 追加层，未列出的字段不参与页面。
export type Status = "ok" | "warn" | "crit" | "nodata" | "info";

export interface NoDataItem { key: string; label: string; reason: string; verify: string }
export interface MetricSpec {
  key: string;
  label: string;
  value: (s: any) => string;
  sub?: (s: any) => string;
  status: (s: any) => Status;
  threshold?: string;
  owner: string;
  caliber: string;
  source: string;
  verify: string;
  note?: string;
  href?: string;
}
export interface ActionSpec {
  key: string;
  dim: string;
  metric: string;
  current: (s: any) => string;
  threshold: string;
  owner: string;
  action: string;
  verify: string;
  status: (s: any) => Status;
  note?: string;
}
export interface DimensionSpec {
  id: string;
  code: string;
  title: string;
  question: string;
  href: string;
  owner: string;
}
export interface ApiResponse {
  ok: boolean;
  source: "business" | "canonical" | null;
  path?: string;
  data: any | null;
  asOf: string | null;
  ageMinutes: number | null;
  stale: boolean;
  degraded: boolean;
  maxAgeMinutes?: number;
  noData?: NoDataItem[];
  notice?: string | null;
  error?: string;
  hint?: string;
  expected?: string[];
}
