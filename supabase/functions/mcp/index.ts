// AI 协作文档 MCP Server - 自动打包
/**
 * 数据库封装模块（supabase-js）
 *
 * 在 Supabase Edge Function 中通过 Deno.env.get 读取环境变量。
 * Supabase 会自动向 Edge Function 注入 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY，
 * 因此这两个变量无需手动设置；WEB_URL 需要通过 `supabase secrets set WEB_URL=...` 配置。
 *
 * 使用 service role key 以获得完整的数据库访问权限（绕过 RLS），因为本服务端是可信的 agent 入口。
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.1';

// ==================== 环境变量 ====================

/** Supabase 项目 URL，由 Edge Function 运行时自动注入 */
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
/** service role key，拥有完整 DB 权限，由 Edge Function 运行时自动注入 */
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
/** 网页编辑器地址，用于拼接文档链接，需手动配置 secret */
const WEB_URL: string = Deno.env.get('WEB_URL') ?? '';

// 创建 Supabase client（service role key 拥有完整 DB 权限）
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    // 服务端不需要会话持久化与自动刷新
    persistSession: false,
    autoRefreshToken: false,
  },
});

// ==================== 类型定义 ====================

/** documents 表行 */
interface DocumentRow {
  id: string;
  title: string;
  content: string;
  status: 'open' | 'closed';
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** document_ops 表行（RPC get_document_ops 返回的单条操作） */
interface OpRecord {
  id: number;
  op_type: 'insert' | 'delete' | 'replace';
  position: number;
  text: string;
  length: number;
  actor: 'human' | 'agent';
  server_version: number;
  created_at: string;
}

/** messages 表行 */
interface MessageRow {
  id: number;
  document_id: string;
  author: 'human' | 'agent';
  content: string;
  created_at: string;
}

/** create_document RPC 返回 */
interface CreateDocumentResult {
  document_id: string;
  version: number;
}

/** get_document_ops RPC 返回 */
interface GetDocumentOpsResult {
  ops: OpRecord[];
  next_version: number;
}

/** apply_ops RPC 返回（三种可能形态） */
interface ApplyOpsResult {
  conflict: boolean;
  new_version?: number;
  expected?: number;
  current?: number;
  error?: string;
}

// ==================== 数据库操作函数 ====================

/**
 * 创建文档（调用 create_document RPC）
 * @param title 文档标题
 * @param initialContent 文档初始内容
 * @returns { document_id, version }
 */
async function createDocument(
  title: string,
  initialContent: string,
): Promise<CreateDocumentResult> {
  const { data, error } = await supabase.rpc('create_document', {
    p_title: title,
    p_initial_content: initialContent,
    p_created_by: 'agent',
  });
  if (error) throw new Error(`create_document 失败: ${error.message}`);
  return data as CreateDocumentResult;
}

/**
 * 查询单个文档（documents 表）
 * @param docId 文档 UUID
 * @returns 文档行，不存在则返回 null
 */
async function getDocument(docId: string): Promise<DocumentRow | null> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', docId)
    .maybeSingle();
  if (error) throw new Error(`查询文档失败: ${error.message}`);
  return (data as DocumentRow) ?? null;
}

/**
 * 获取文档当前已提交的最新版本号。
 * doc_versions.next_version 指向「下一个待分配」的版本号，因此当前最新版本 = next_version - 1。
 * @param docId 文档 UUID
 * @returns 当前版本号；文档不存在时返回 0
 */
async function getDocumentVersion(docId: string): Promise<number> {
  const { data, error } = await supabase
    .from('doc_versions')
    .select('next_version')
    .eq('document_id', docId)
    .maybeSingle();
  if (error) throw new Error(`查询版本失败: ${error.message}`);
  if (!data) return 0;
  return (data.next_version as number) - 1;
}

/**
 * 获取文档增量操作记录（调用 get_document_ops RPC）
 * @param docId 文档 UUID
 * @param sinceVersion 仅返回 server_version 大于此值的操作（默认 0，即全部）
 * @returns { ops, next_version }
 */
async function getDocumentOps(
  docId: string,
  sinceVersion: number = 0,
): Promise<GetDocumentOpsResult> {
  const { data, error } = await supabase.rpc('get_document_ops', {
    p_doc_id: docId,
    p_since_version: sinceVersion,
  });
  if (error) throw new Error(`get_document_ops 失败: ${error.message}`);
  return data as GetDocumentOpsResult;
}

/**
 * 应用编辑操作（调用 apply_ops RPC）
 *
 * 乐观并发控制：服务端会比较 base_version 与 doc_versions.next_version，
 * 不一致则返回 conflict，调用方需先通过 get_document_ops 同步增量后再重试。
 *
 * @param docId 文档 UUID
 * @param ops 操作数组（与 Op 类型一致，含 type/position/text/length）
 * @param actor 操作发起者，'human' 或 'agent'（本服务端固定为 'agent'）
 * @param baseVersion 调用方所基于的版本号
 * @returns { conflict, new_version? } 或 { conflict: true, expected, current } 或 { error }
 */
async function applyOps(
  docId: string,
  ops: unknown[],
  actor: 'human' | 'agent',
  baseVersion: number,
): Promise<ApplyOpsResult> {
  const { data, error } = await supabase.rpc('apply_ops', {
    p_doc_id: docId,
    p_ops: ops,
    p_actor: actor,
    p_base_version: baseVersion,
  });
  if (error) throw new Error(`apply_ops 失败: ${error.message}`);
  return data as ApplyOpsResult;
}

/**
 * 关闭文档：将 status 置为 'closed'、closed_at 置为当前时间，并返回最终全文。
 * @param docId 文档 UUID
 * @returns 更新后的文档行；文档不存在则返回 null
 */
async function closeDocument(docId: string): Promise<DocumentRow | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('documents')
    .update({ status: 'closed', closed_at: now, updated_at: now })
    .eq('id', docId)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`关闭文档失败: ${error.message}`);
  return (data as DocumentRow) ?? null;
}

/**
 * 插入一条消息到 messages 表
 * @param docId 文档 UUID
 * @param author 发送者，'human' 或 'agent'
 * @param content 消息内容
 * @returns 新插入的消息行
 */
async function sendMessage(
  docId: string,
  author: 'human' | 'agent',
  content: string,
): Promise<MessageRow> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ document_id: docId, author, content })
    .select('*')
    .single();
  if (error) throw new Error(`发送消息失败: ${error.message}`);
  return data as MessageRow;
}

/**
 * 查询文档的消息列表，支持增量拉取
 * @param docId 文档 UUID
 * @param afterId 仅返回 id 大于此值的消息（默认 0，即全部）
 * @returns 消息数组（按 id 升序）
 */
async function getMessages(docId: string, afterId: number = 0): Promise<MessageRow[]> {
  let query = supabase
    .from('messages')
    .select('*')
    .eq('document_id', docId)
    .order('id', { ascending: true });
  if (afterId > 0) {
    query = query.gt('id', afterId);
  }
  const { data, error } = await query;
  if (error) throw new Error(`查询消息失败: ${error.message}`);
  return (data as MessageRow[]) ?? [];
}


/**
 * MCP 工具定义模块（无 SDK 依赖，使用原生 JSON Schema）
 *
 * 定义 10 个工具，供 AI agent 调用，覆盖「创建 - 读取 - 编辑 - 关闭 - 下载 - 消息 - 等待」完整协作闭环：
 *  1. create_document       创建协作文档并返回编辑链接
 *  2. get_document          获取文档当前全文与版本
 *  3. get_document_ops      获取增量操作记录（用于轮询人类编辑）
 *  4. edit_document         提交编辑操作（基于 base_version 的乐观并发控制）
 *  5. close_document        关闭文档并返回最终全文
 *  6. download_document     下载文档为 Markdown
 *  7. send_message          向文档会话发送消息
 *  8. get_messages          获取文档会话消息（支持增量拉取）
 *  9. wait_for_message      长轮询等待人类发送新消息（最多 30 秒）
 * 10. wait_for_document_ops 长轮询等待人类编辑文档（最多 30 秒）
 */


// ==================== 类型定义 ====================

/** JSON Schema 类型 */
interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  minimum?: number;
  anyOf?: JsonSchema[];
  [key: string]: unknown;
}

/** MCP 工具定义 */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** MCP 工具返回值 */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ==================== 辅助函数 ====================

/** 构造纯文本返回内容 */
function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/** 把任意对象序列化为 JSON 文本返回 */
function jsonResult(data: unknown, isError = false): ToolResult {
  return textResult(JSON.stringify(data, null, 2), isError);
}

/** Promise 延时（用于长轮询间隔） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 拼接网页编辑器链接 */
function buildDocLink(docId: string): string {
  // 返回 Edge Function ?doc= 短链接
  // Edge Function 的 ?doc= 路由从 Storage 读取编辑器 HTML 并以 TEXT/HTML 返回
  // 使用大写 TEXT/HTML 绕过 Supabase 平台对 text/html 的 Content-Type 覆盖
  const fnUrl = (Deno.env.get('SUPABASE_URL') ?? '') + '/functions/v1/mcp';
  return `${fnUrl}?doc=${docId}`;
}

// ==================== 工具定义 ====================

/** 全部 8 个工具的定义 */
const tools: ToolDefinition[] = [
  // 1. create_document
  {
    name: 'create_document',
    description:
      '创建一个新的协作文档，返回文档 ID、网页编辑链接和初始版本号（version=0）。\n' +
      '协作工作流：\n' +
      '1. 创建文档，把链接发给人类\n' +
      '2. 调用 wait_for_message 等待人类消息（超时后重新调用继续等待）\n' +
      '3. 收到消息后，可用 edit_document 编辑文档、send_message 回复消息\n' +
      '4. 编辑前先调用 get_document 获取最新 version 和 content，用 version 作为 edit_document 的 base_version\n' +
      '5. 回复后再次调用 wait_for_message 等待下一轮交互\n' +
      '6. 如需同时等待消息和编辑，可交替调用 wait_for_message 和 wait_for_document_ops\n' +
      '7. 人类明确表示完成或不再需要协作时，调用 close_document 关闭文档',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题' },
        initial_content: { type: 'string', description: '文档初始内容（可选，默认为空字符串）' },
      },
      required: ['title'],
    },
    handler: async (args) => {
      const title = args.title as string;
      const initialContent = (args.initial_content as string) ?? '';
      const result = await createDocument(title, initialContent);
      return jsonResult({
        document_id: result.document_id,
        link: buildDocLink(result.document_id),
        version: result.version,
      });
    },
  },

  // 2. get_document
  {
    name: 'get_document',
    description:
      '获取文档的标题、当前全文内容、状态（open/closed）和最新版本号。\n' +
      'version 是已应用的操作数（= next_version - 1），编辑前务必获取此值作为 edit_document 的 base_version。\n' +
      '如果只需检查人类是否编辑了文档，用 get_document_ops 或 wait_for_document_ops 更高效。',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '文档 UUID' },
      },
      required: ['document_id'],
    },
    handler: async (args) => {
      const documentId = args.document_id as string;
      const doc = await getDocument(documentId);
      if (!doc) {
        return jsonResult({ error: '文档不存在', document_id: documentId }, true);
      }
      const version = await getDocumentVersion(documentId);
      return jsonResult({
        title: doc.title,
        content: doc.content,
        status: doc.status,
        version,
      });
    },
  },

  // 3. get_document_ops
  {
    name: 'get_document_ops',
    description:
      '获取文档自 since_version 之后的增量操作记录，用于检查人类（或其它 actor）的编辑。\n' +
      '返回 ops 数组与 next_version。\n' +
      '版本号说明：version（get_document 返回）= next_version - 1。next_version 是下一个待分配的版本号，不是当前版本。\n' +
      '轮询方式：首次用 since_version=0，之后每次用上一次返回的 next_version。',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '文档 UUID' },
        since_version: {
          type: 'integer',
          minimum: 0,
          description: '从此版本号之后获取操作（默认 0，即获取全部）',
        },
      },
      required: ['document_id'],
    },
    handler: async (args) => {
      const documentId = args.document_id as string;
      const sinceVersion = (args.since_version as number) ?? 0;
      const result = await getDocumentOps(documentId, sinceVersion);
      const ops = (result.ops ?? []).map((op) => ({
        type: op.op_type,
        position: op.position,
        text: op.text,
        length: op.length,
        actor: op.actor,
        server_version: op.server_version,
        created_at: op.created_at,
      }));
      return jsonResult({ ops, next_version: result.next_version });
    },
  },

  // 4. edit_document
  {
    name: 'edit_document',
    description:
      '提交一组编辑操作到文档。基于 base_version 做乐观并发控制。\n' +
      'base_version 应传 get_document 返回的 version 值（= 已应用的操作数）。\n' +
      '若返回 conflict=true，说明文档已被修改：调用 get_document 获取最新 version 和 content，调整操作位置后重试。\n' +
      '成功时返回 new_version，下一次编辑应使用此值作为 base_version。\n' +
      'operations 中的 position 是字符偏移量（基于 get_document 返回的 content），从 0 开始。',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '文档 UUID' },
        operations: {
          type: 'array',
          description: '编辑操作数组（insert / delete / replace）',
          items: {
            type: 'object',
            anyOf: [
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['insert'] },
                  position: { type: 'integer', minimum: 0 },
                  text: { type: 'string' },
                },
                required: ['type', 'position', 'text'],
              },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['delete'] },
                  position: { type: 'integer', minimum: 0 },
                  length: { type: 'integer', minimum: 0 },
                },
                required: ['type', 'position', 'length'],
              },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['replace'] },
                  position: { type: 'integer', minimum: 0 },
                  length: { type: 'integer', minimum: 0 },
                  text: { type: 'string' },
                },
                required: ['type', 'position', 'length', 'text'],
              },
            ],
          },
        },
        base_version: { type: 'integer', minimum: 0, description: '基于的版本号（调用前通过 get_document 获取）' },
      },
      required: ['document_id', 'operations', 'base_version'],
    },
    handler: async (args) => {
      const documentId = args.document_id as string;
      const operations = args.operations as unknown[];
      const baseVersion = args.base_version as number;
      const result = await applyOps(documentId, operations, 'agent', baseVersion);
      if (result.error) {
        return jsonResult({ error: result.error }, true);
      }
      if (result.conflict) {
        return jsonResult(
          {
            error: '版本冲突：文档已被其他人修改，请先调用 get_document_ops 同步增量后再重试',
            conflict: true,
            expected: result.expected,
            current: result.current,
          },
          true,
        );
      }
      return jsonResult({ new_version: result.new_version });
    },
  },

  // 5. close_document
  {
    name: 'close_document',
    description: '关闭文档（标记 status=closed），返回文档最终全文。关闭后无法再编辑。',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '文档 UUID' },
      },
      required: ['document_id'],
    },
    handler: async (args) => {
      const documentId = args.document_id as string;
      const doc = await closeDocument(documentId);
      if (!doc) {
        return jsonResult({ error: '文档不存在', document_id: documentId }, true);
      }
      return jsonResult({ success: true, content: doc.content });
    },
  },

  // 6. download_document
  {
    name: 'download_document',
    description:
      '下载文档为 Markdown 文本。返回标题、纯文本内容和 markdown 字段（markdown 即 content 本身）。',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '文档 UUID' },
      },
      required: ['document_id'],
    },
    handler: async (args) => {
      const documentId = args.document_id as string;
      const doc = await getDocument(documentId);
      if (!doc) {
        return jsonResult({ error: '文档不存在', document_id: documentId }, true);
      }
      return jsonResult({ title: doc.title, content: doc.content, markdown: doc.content });
    },
  },

  // 7. send_message
  {
    name: 'send_message',
    description: '向文档会话发送一条消息（author 固定为 agent）。返回 message_id 和 created_at。',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '文档 UUID' },
        content: { type: 'string', description: '消息内容' },
      },
      required: ['document_id', 'content'],
    },
    handler: async (args) => {
      const documentId = args.document_id as string;
      const content = args.content as string;
      const msg = await sendMessage(documentId, 'agent', content);
      return jsonResult({ message_id: msg.id, created_at: msg.created_at });
    },
  },

  // 8. get_messages
  {
    name: 'get_messages',
    description:
      '获取文档会话中的消息列表。传入 after_id 可增量拉取该 ID 之后的新消息（用于轮询人类发来的消息）。' +
      '建议轮询方式：首次不传（获取全部），之后每次传入已处理的最后一条消息 id。',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '文档 UUID' },
        after_id: {
          type: 'integer',
          minimum: 0,
          description: '只返回 id 大于此值的消息（默认 0，即全部）',
        },
      },
      required: ['document_id'],
    },
    handler: async (args) => {
      const documentId = args.document_id as string;
      const afterId = (args.after_id as number) ?? 0;
      const messages = await getMessages(documentId, afterId);
      return jsonResult({ messages });
    },
  },

  // 9. wait_for_message
  {
    name: 'wait_for_message',
    description:
      '长轮询等待人类发送新消息（最多阻塞 30 秒）。' +
      '创建文档后应循环调用此工具：收到人类消息后处理并用 send_message 回复，然后再次调用本工具等待下一条。' +
      '超时（timeout=true）时表示 30 秒内无新消息，应再次调用继续等待。' +
      'after_id 应传入已处理的最后一条消息 id（首次传 0）。',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '文档 UUID' },
        after_id: {
          type: 'integer',
          minimum: 0,
          description: '只等待 id 大于此值的消息（默认 0）',
        },
      },
      required: ['document_id'],
    },
    handler: async (args) => {
      const documentId = args.document_id as string;
      const afterId = (args.after_id as number) ?? 0;

      const MAX_WAIT_MS = 30_000;
      const POLL_INTERVAL_MS = 2_000;
      const startTime = Date.now();

      while (Date.now() - startTime < MAX_WAIT_MS) {
        const messages = await getMessages(documentId, afterId);
        const humanMessages = messages.filter((m) => m.author === 'human');
        if (humanMessages.length > 0) {
          return jsonResult({ messages: humanMessages, timeout: false });
        }
        await sleep(POLL_INTERVAL_MS);
      }

      return jsonResult({ messages: [], timeout: true });
    },
  },

  // 10. wait_for_document_ops
  {
    name: 'wait_for_document_ops',
    description:
      '长轮询等待人类编辑文档（最多阻塞 30 秒）。\n' +
      '当需要等待人类在网页编辑器中修改文档时调用。\n' +
      '注意：网页编辑器有 2 秒防抖延迟，人类停止输入 2 秒后变更才会上传到服务端。\n' +
      '超时（timeout=true）时表示 30 秒内无新编辑，应再次调用继续等待。\n' +
      'since_version 应传入当前已知版本号（即 get_document 返回的 version，首次传 0）。',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: '文档 UUID' },
        since_version: {
          type: 'integer',
          minimum: 0,
          description: '从此版本号之后获取操作（默认 0）',
        },
      },
      required: ['document_id'],
    },
    handler: async (args) => {
      const documentId = args.document_id as string;
      const sinceVersion = (args.since_version as number) ?? 0;

      const MAX_WAIT_MS = 30_000;
      const POLL_INTERVAL_MS = 2_000;
      const startTime = Date.now();

      while (Date.now() - startTime < MAX_WAIT_MS) {
        const result = await getDocumentOps(documentId, sinceVersion);
        const humanOps = (result.ops ?? []).filter((op) => op.actor === 'human');
        if (humanOps.length > 0) {
          const ops = humanOps.map((op) => ({
            type: op.op_type,
            position: op.position,
            text: op.text,
            length: op.length,
            actor: op.actor,
            server_version: op.server_version,
            created_at: op.created_at,
          }));
          return jsonResult({ ops, next_version: result.next_version, timeout: false });
        }
        await sleep(POLL_INTERVAL_MS);
      }

      return jsonResult({ ops: [], next_version: sinceVersion, timeout: true });
    },
  },
];

/** 按名称查找工具 */
function findTool(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}


/**
 * MCP Server 入口（Supabase Edge Function / Deno 运行时）
 *
 * 手动实现 MCP 协议（JSON-RPC 2.0 over Streamable HTTP），不依赖 @modelcontextprotocol/sdk。
 * 原因：MCP SDK 的 McpServer 构造函数在 Supabase Edge Function Deno 运行时中
 * 会引发不可捕获的 worker 崩溃（WORKER_ERROR），因此改用手动实现。
 *
 * 支持的 MCP 方法：
 *  - initialize           返回服务器能力与协议版本
 *  - notifications/initialized  返回 202（无需响应体）
 *  - tools/list           返回全部已注册工具及其 JSON Schema
 *  - tools/call           分发到对应工具处理函数
 *
 * 环境变量（均由 Supabase 自动注入或手动配置）：
 *  - SUPABASE_URL              （自动注入）
 *  - SUPABASE_SERVICE_ROLE_KEY （自动注入）
 *  - WEB_URL                   （需通过 supabase secrets set WEB_URL=... 配置）
 */
import { Hono } from 'npm:hono@4.7.6';


// ==================== 常量 ====================

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'collab-doc-mcp', version: '1.0.0' };
const SERVER_CAPABILITIES = { tools: {} };

// CORS 响应头
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

// ==================== JSON-RPC 辅助函数 ====================

/** 构造 JSON-RPC 成功响应 */
function rpcResult(id: unknown, result: unknown): Response {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  return new Response(body, {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** 构造 JSON-RPC 错误响应 */
function rpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): Response {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  const body = JSON.stringify({ jsonrpc: '2.0', id, error });
  return new Response(body, {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ==================== MCP 方法处理 ====================

/** 处理 MCP initialize 请求 */
function handleInitialize(id: unknown): Response {
  return rpcResult(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: SERVER_CAPABILITIES,
    serverInfo: SERVER_INFO,
  });
}

/** 处理 MCP tools/list 请求 */
function handleToolsList(id: unknown): Response {
  const toolList = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  return rpcResult(id, { tools: toolList });
}

/** 处理 MCP tools/call 请求 */
async function handleToolsCall(id: unknown, params: unknown): Promise<Response> {
  const p = params as { name?: string; arguments?: Record<string, unknown> } | null;
  if (!p || !p.name) {
    return rpcError(id, -32602, 'Invalid params: missing "name"');
  }

  const tool = findTool(p.name);
  if (!tool) {
    return rpcError(id, -32602, `Unknown tool: ${p.name}`);
  }

  try {
    const args = p.arguments ?? {};
    const result = await tool.handler(args);
    return rpcResult(id, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rpcError(
      id,
      -32603,
      `Tool execution failed: ${message}`,
      error instanceof Error ? { stack: error.stack } : undefined,
    );
  }
}

// ==================== Hono 应用 ====================

const app = new Hono();

app.all('*', async (c) => {
  const method = c.req.method;

  // OPTIONS：CORS 预检
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // GET：健康检查 或 网页编辑器
  if (method === 'GET') {
    const url = new URL(c.req.url);

    // 文档编辑器路由：GET ?doc={docId}
    // 使用 TEXT/HTML（大写）绕过 Supabase 平台对 text/html 的 Content-Type 覆盖和 CSP 注入
    // 浏览器按 HTTP 规范不区分 Content-Type 大小写，正常渲染为 HTML
    // 编辑器 HTML 以 .json 格式存储在 Storage（绕过 HTML 上传限制），路径为绝对路径
    if (url.searchParams.has('doc')) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
      const htmlResp = await fetch(`${supabaseUrl}/storage/v1/object/public/web/editor.json`);
      if (!htmlResp.ok) {
        return new Response('Web editor not found', { status: 404, headers: CORS_HEADERS });
      }
      const html = await htmlResp.text();
      return new Response(html, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'TEXT/HTML; charset=utf-8',
        },
      });
    }

    // 健康检查
    return c.json(
      {
        status: 'ok',
        service: SERVER_INFO.name,
        version: SERVER_INFO.version,
        protocol: 'streamable-http (stateless, manual implementation)',
      },
      { headers: CORS_HEADERS },
    );
  }

  // 仅支持 POST
  if (method !== 'POST') {
    return c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
      405,
      { headers: CORS_HEADERS },
    );
  }

  // 解析 JSON-RPC 请求
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error: invalid JSON');
  }

  // 支持批量请求
  const requests = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];

  for (const req of requests) {
    const r = req as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

    // 验证 JSON-RPC 2.0
    if (!r || r.jsonrpc !== '2.0' || !r.method) {
      responses.push({
        jsonrpc: '2.0',
        id: r?.id ?? null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      continue;
    }

    const { id, method: m, params } = r;

    // 通知（无 id）：不需要返回响应
    if (id === undefined || id === null) {
      // notifications/initialized 等通知，静默处理
      continue;
    }

    // 分发到对应处理函数
    try {
      let resp: Response;
      switch (m) {
        case 'initialize':
          resp = handleInitialize(id);
          break;
        case 'notifications/initialized':
          // 有 id 的 notifications/initialized（不符合规范但兼容）
          resp = rpcResult(id, {});
          break;
        case 'tools/list':
          resp = handleToolsList(id);
          break;
        case 'tools/call':
          resp = await handleToolsCall(id, params);
          break;
        case 'ping':
          resp = rpcResult(id, {});
          break;
        default:
          resp = rpcError(id, -32601, `Method not found: ${m}`);
      }
      // 提取响应体（用于批量合并）
      const respText = await resp.text();
      responses.push(JSON.parse(respText));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      responses.push({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal error: ${message}` },
      });
    }
  }

  // 如果全是通知（无响应），返回 202
  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  // 单请求返回单个响应，批量请求返回数组
  const resultBody = Array.isArray(body)
    ? JSON.stringify(responses)
    : JSON.stringify(responses[0]);

  return new Response(resultBody, {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
});

// Supabase Edge Function 入口
Deno.serve(app.fetch);

