# AI-People-Collab-Doc

面向 AI Agent 的实时协作文档 MCP Server：人类与 Agent 在同一文档上同时编辑、对话，实时同步。

内置 10 个 MCP 工具：创建、读取、增量拉取、编辑、关闭文档，收发消息，长轮询等待对方输入或编辑。文档链接即凭证，免登录；用版本号冲突检测替代 CRDT，人类输入 2 秒防抖打包提交。

全程 HTTP 长轮询，任何 MCP 客户端都能接入，无需 WebSocket 或常驻服务。

技术栈：Supabase Edge Functions（Deno/TS）+ Postgres + Realtime，网页编辑器由 Edge Function 直接托管，单项目部署，免费层可跑通。

流程：AI 写初稿 → 人在网页上改 → AI 拉增量继续优化 → 关闭导出全文。

## MCP 工具（10 个）

| 工具 | 说明 |
|---|---|
| `create_document` | 创建文档，返回文档链接 |
| `get_document` | 读取文档全文与版本 |
| `get_document_ops` | 增量拉取指定版本之后的编辑操作 |
| `edit_document` | 提交编辑操作（insert/delete/replace，带冲突检测） |
| `close_document` | 关闭文档（锁定编辑） |
| `download_document` | 导出全文 |
| `send_message` | 给对方发消息 |
| `get_messages` | 读取消息 |
| `wait_for_message` | 长轮询等待新消息 |
| `wait_for_document_ops` | 长轮询等待新的编辑操作 |

## 快速开始

前置条件：一个 Supabase 项目（免费层即可），本地安装 Node.js。

```bash
# 1. 安装 CLI 并登录
npm install -g supabase
supabase login

# 2. 关联你的项目（<your-project-ref> 见 Dashboard 项目 URL）
supabase link --project-ref <your-project-ref>

# 3. 应用数据库迁移 + seed（也可把 supabase/migrations/*.sql 粘贴到 SQL Editor 执行）
supabase db push

# 4. 部署 Edge Function
supabase functions deploy mcp
```

上传网页编辑器（Dashboard → Storage）：

1. 创建 **公开** 桶 `web`
2. 上传 `web/editor.json` 到桶根目录
3. 上传 `web/assets/` 下的 `index-*.js`、`index-*.css` 到 `web/assets/`（保持目录结构）

> 编辑器为 Vite 构建产物，后端地址与公开 key 在构建时写入，当前指向演示项目。
> 如需指向自己的项目，可修改前端源码重新构建，或直接让编辑器继续使用 demo 后端。

## 使用

MCP 客户端（如 Claude Desktop / Cursor / 任意支持 Streamable HTTP 的客户端）接入：

```json
{
  "mcpServers": {
    "ai-collab-doc": {
      "url": "https://<your-project-ref>.supabase.co/functions/v1/mcp"
    }
  }
}
```

- 让 AI 调用 `create_document`，返回形如 `https://<ref>.supabase.co/functions/v1/mcp?doc=<id>` 的链接
- 浏览器打开该链接即为网页编辑器，人直接编辑、留言；AI 通过同一文档 ID 协同
- 文档链接即凭证：持有链接即可读写该文档，适合轻量协作场景

## 项目结构

```
supabase/
  migrations/20261113120000_init.sql   # 数据库结构、RLS、Realtime 发布、业务 RPC
  seed.sql                             # 演示文档
  functions/mcp/index.ts               # MCP Server + 网页编辑器托管（单文件）
web/                                   # 网页编辑器构建产物（部署到 Storage web 桶）
.env.example                           # 环境变量示例
```

## License

[MIT](LICENSE)
