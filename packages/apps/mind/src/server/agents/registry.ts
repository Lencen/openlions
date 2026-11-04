/**
 * Agent Registry — 统一管理所有接入飞轮的 agent
 * 新增 agent 只需在此文件添加一项，db-writer/pipeline 等处引用即可
 */
export const AGENTS = {
  hermes: {
    id: "HERMES_SESSION",
    name: "Hermes",
    color: "blue",
    description: "Hermes 主助手会话（.hermes/state.db）",
  },
  claude_code: {
    id: "CLAUDE_CONVERSATION",
    name: "Claude Code",
    color: "purple",
    description: "Claude Code 对话会话",
  },
  // 新 agent 接入示例：
  // my_agent: {
  //   id: "MY_AGENT",
  //   name: "My Agent",
  //   color: "green",
  //   description: "我的自定义 agent",
  // },
} as const;

export type AgentId = (typeof AGENTS)[keyof typeof AGENTS]["id"];
export type Agent = (typeof AGENTS)[keyof typeof AGENTS];

/** 通过 id 查找 agent */
export function getAgent(id: string): Agent | undefined {
  return Object.values(AGENTS).find((a) => a.id === id);
}

/** 所有 agent id 列表 */
export const ALL_AGENT_IDS = Object.values(AGENTS).map((a) => a.id);