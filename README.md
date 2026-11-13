# AI-People-Collab-Doc
面向 AI Agent 的实时协作文档 MCP Server：人类与 Agent 在同一文档上同时编辑、对话，实时同步。  内置 10 个 MCP 工具：创建、读取、增量拉取、编辑、关闭文档，收发消息，长轮询等待对方输入或编辑。文档链接即凭证，免登录；用版本号冲突检测替代 CRDT，人类输入 2 秒防抖打包提交。  全程 HTTP 长轮询，任何 MCP 客户端都能接入，无需 WebSocket 或常驻服务。  技术栈：Supabase Edge Functions（Deno/TS）+ Postgres + Realtime，网页编辑器由 Edge Function 直接托管，单项目部署，免费层可跑通。  流程：AI 写初稿 → 人在网页上改 → AI 拉增量继续优化 → 关闭导出全文。
