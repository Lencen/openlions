// agents/onboard 页 · 共享类型 (从 page.tsx 抽出, 页面瘦身)
export interface OnboardForm {
  agent_id: string;
  display_name: string;
  channel: string;
  host: string;
}
