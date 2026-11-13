-- ============================================================
-- AI-People-Collab-Doc 初始数据库结构
-- 适用于全新 Supabase 项目（Postgres 15+）
--
-- 应用方式（二选一）：
--   1. supabase link --project-ref <your-project-ref> && supabase db push
--   2. 在 Supabase Dashboard → SQL Editor 中直接粘贴执行本文件
-- ============================================================

-- ========== 表 ==========
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  title text not null default '未命名文档',
  content text not null default '',
  status text not null default 'open',
  created_by text not null default 'anonymous',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint documents_status_check check (status = any (array['open'::text, 'closed'::text]))
);

create table public.doc_versions (
  document_id uuid primary key references public.documents (id) on delete cascade,
  next_version bigint not null default 1
);

create table public.document_ops (
  id bigserial primary key,
  document_id uuid not null references public.documents (id) on delete cascade,
  op_type text not null,
  position integer not null default 0,
  text text not null default '',
  length integer not null default 0,
  actor text not null default 'human',
  server_version bigint not null,
  created_at timestamptz not null default now(),
  constraint document_ops_actor_check check (actor = any (array['human'::text, 'agent'::text])),
  constraint document_ops_op_type_check check (op_type = any (array['insert'::text, 'delete'::text, 'replace'::text]))
);

create table public.messages (
  id bigserial primary key,
  document_id uuid not null references public.documents (id) on delete cascade,
  author text not null,
  content text not null,
  created_at timestamptz not null default now(),
  constraint messages_author_check check (author = any (array['human'::text, 'agent'::text]))
);

create index idx_ops_doc on public.document_ops using btree (document_id, server_version);
create index idx_msg_doc on public.messages using btree (document_id, id);

-- ========== Realtime：把变更广播给网页编辑器 ==========
alter publication supabase_realtime add table public.documents;
alter publication supabase_realtime add table public.document_ops;
alter publication supabase_realtime add table public.messages;

-- ========== RLS ==========
alter table public.documents enable row level security;
alter table public.doc_versions enable row level security;
alter table public.document_ops enable row level security;
alter table public.messages enable row level security;

create policy "anon_select_documents" on public.documents for select to anon, authenticated using (true);
create policy "anon_update_documents" on public.documents for update to anon, authenticated using (true) with check (true);
create policy "anon_select_doc_versions" on public.doc_versions for select to anon, authenticated using (true);
create policy "anon_select_document_ops" on public.document_ops for select to anon, authenticated using (true);
create policy "anon_select_messages" on public.messages for select to anon, authenticated using (true);
create policy "anon_insert_messages" on public.messages for insert to anon, authenticated with check (true);

-- ========== 业务函数（SECURITY DEFINER，版本号冲突检测在此实现）==========
create or replace function public.apply_ops(p_doc_id uuid, p_ops jsonb, p_actor text, p_base_version bigint)
 returns jsonb
 language plpgsql
 security definer
as $$
DECLARE
  v_doc documents%ROWTYPE;
  v_next BIGINT;
  v_op JSONB;
  v_pos INT;
  v_len INT;
  v_text TEXT;
  v_content TEXT;
BEGIN
  SELECT * INTO v_doc FROM documents WHERE id = p_doc_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'document not found');
  END IF;
  IF v_doc.status <> 'open' THEN
    RETURN jsonb_build_object('error', 'document closed');
  END IF;

  SELECT next_version INTO v_next FROM doc_versions WHERE document_id = p_doc_id FOR UPDATE;
  IF v_next IS NULL THEN
    INSERT INTO doc_versions(document_id) VALUES (p_doc_id) RETURNING next_version INTO v_next;
  END IF;

  -- base_version 应与 version（= next_version - 1）一致
  -- version 表示已应用的操作数，next_version 是下一个待分配的版本号
  IF v_next - 1 <> p_base_version THEN
    RETURN jsonb_build_object('conflict', true, 'expected', p_base_version, 'current', v_next - 1);
  END IF;

  v_content := v_doc.content;
  FOR v_op IN SELECT * FROM jsonb_array_elements(p_ops) LOOP
    v_pos := (v_op->>'position')::INT;
    v_len := COALESCE((v_op->>'length')::INT, 0);
    v_text := COALESCE(v_op->>'text', '');
    CASE v_op->>'type'
      WHEN 'insert' THEN
        v_content := substring(v_content from 1 for v_pos) || v_text || substring(v_content from v_pos + 1);
      WHEN 'delete' THEN
        v_content := substring(v_content from 1 for v_pos) || substring(v_content from v_pos + v_len + 1);
      WHEN 'replace' THEN
        v_content := substring(v_content from 1 for v_pos) || v_text || substring(v_content from v_pos + v_len + 1);
    END CASE;
    INSERT INTO document_ops(document_id, op_type, position, text, length, actor, server_version)
    VALUES (p_doc_id, v_op->>'type', v_pos, v_text, v_len, p_actor, v_next);
    v_next := v_next + 1;
  END LOOP;

  UPDATE documents SET content = v_content, updated_at = now() WHERE id = p_doc_id;
  UPDATE doc_versions SET next_version = v_next WHERE document_id = p_doc_id;
  RETURN jsonb_build_object('conflict', false, 'new_version', v_next - 1);
END $$;

create or replace function public.create_document(p_title text default '未命名文档'::text, p_initial_content text default ''::text, p_created_by text default 'anonymous'::text)
 returns jsonb
 language plpgsql
 security definer
as $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO documents(title, content, created_by) VALUES (p_title, p_initial_content, p_created_by)
  RETURNING id INTO v_id;
  INSERT INTO doc_versions(document_id) VALUES (v_id);
  RETURN jsonb_build_object('document_id', v_id, 'version', 0);
END $$;

create or replace function public.get_document_ops(p_doc_id uuid, p_since_version bigint default 0)
 returns jsonb
 language plpgsql
 security definer
as $$
DECLARE
  v_result JSONB;
  v_next BIGINT;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id,
    'op_type', op_type,
    'position', position,
    'text', text,
    'length', length,
    'actor', actor,
    'server_version', server_version,
    'created_at', created_at
  ) ORDER BY server_version), '[]'::jsonb) INTO v_result
  FROM document_ops
  WHERE document_id = p_doc_id AND server_version > p_since_version;

  SELECT next_version INTO v_next FROM doc_versions WHERE document_id = p_doc_id;
  IF v_next IS NULL THEN
    v_next := 0;
  END IF;

  RETURN jsonb_build_object('ops', v_result, 'next_version', v_next);
END $$;

grant execute on function public.create_document(text, text, text) to anon, authenticated;
grant execute on function public.apply_ops(uuid, jsonb, text, bigint) to anon, authenticated;
grant execute on function public.get_document_ops(uuid, bigint) to anon, authenticated;
