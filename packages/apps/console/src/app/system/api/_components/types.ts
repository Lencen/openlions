// system/api 页 · 共享类型 (从 page.tsx 抽出, 页面瘦身)
export interface Svc {
  name: string;
  display_name: string;
  description: string;
  endpoint: string;
  version: string;
  status: string;
  available_perms?: string | string[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
}
