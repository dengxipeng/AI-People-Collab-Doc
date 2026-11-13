-- 演示数据：`supabase db reset` 时自动执行
select public.create_document(
  '欢迎使用 AI 协作文档',
  '这是 seed 自动创建的演示文档。

协作流程：
1. 打开函数返回的 ?doc= 链接，在网页上直接编辑；
2. 让 AI 通过 MCP 接入同一个文档链接；
3. AI 拉取增量、继续优化，双方实时同步。'
);
