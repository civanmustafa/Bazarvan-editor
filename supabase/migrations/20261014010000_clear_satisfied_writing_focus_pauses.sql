begin;

-- A writing item can become a benign no-op after the finish-first lane has
-- already recorded a terminal pause. Clear only pauses whose own error proves
-- that automatic writing is no longer required; unrelated review pauses stay.
create or replace function public.clear_satisfied_automatic_writing_focus(
  p_article_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requirement jsonb;
  v_deleted integer := 0;
begin
  if p_article_id is null then return false; end if;

  v_requirement := public.automatic_content_writing_requirement(p_article_id);
  if coalesce((v_requirement->>'required')::boolean, false) then return false; end if;

  delete from public.automatic_article_focus_pauses as pause
  where pause.article_id = p_article_id
    and (
      pause.error_code in (
        'automatic_writing_not_required',
        'automatic_article_editor_not_empty',
        'article_left_automation_scope'
      )
      or lower(coalesce(pause.error_message, '')) like '%automatic writing is no longer required%'
    );
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    update public.automatic_article_focus as focus
    set state = 'idle',
        current_stage = null,
        last_release_reason = 'automatic_writing_satisfied',
        released_at = now(),
        next_retry_at = null,
        last_error_code = null,
        last_error = null,
        last_progress_at = now(),
        updated_at = now()
    where focus.singleton is true
      and focus.article_id is null
      and focus.last_article_id = p_article_id
      and focus.state = 'needs_attention';
  end if;

  return v_deleted > 0;
end;
$$;

create or replace function public.clear_satisfied_automatic_writing_focus_from_article()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.clear_satisfied_automatic_writing_focus(new.id);
  return new;
end;
$$;

create or replace function public.clear_satisfied_automatic_writing_focus_from_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled'
     and new.last_error_code in (
       'automatic_writing_not_required',
       'automatic_article_editor_not_empty',
       'article_left_automation_scope'
     ) then
    perform public.clear_satisfied_automatic_writing_focus(new.article_id);
  end if;
  return new;
end;
$$;

drop trigger if exists clear_satisfied_automatic_writing_focus_after_article
  on public.articles;
create trigger clear_satisfied_automatic_writing_focus_after_article
after update of status, content_json, content_html, plain_text on public.articles
for each row execute function public.clear_satisfied_automatic_writing_focus_from_article();

drop trigger if exists clear_satisfied_automatic_writing_focus_after_item
  on public.content_writing_automation_items;
create trigger clear_satisfied_automatic_writing_focus_after_item
after insert or update of status, last_error_code, last_error
on public.content_writing_automation_items
for each row execute function public.clear_satisfied_automatic_writing_focus_from_item();

-- Repair pauses written before the canonical requirement guard existed.
do $$
declare
  v_article_id uuid;
begin
  for v_article_id in
    select pause.article_id
    from public.automatic_article_focus_pauses as pause
    where pause.error_code in (
      'automatic_writing_not_required',
      'automatic_article_editor_not_empty',
      'article_left_automation_scope'
    )
      or lower(coalesce(pause.error_message, '')) like '%automatic writing is no longer required%'
  loop
    perform public.clear_satisfied_automatic_writing_focus(v_article_id);
  end loop;
end;
$$;

create or replace function public.content_writing_automation_schema_version()
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select 12;
$$;

revoke all on function public.clear_satisfied_automatic_writing_focus(uuid)
  from public, anon, authenticated;
revoke all on function public.clear_satisfied_automatic_writing_focus_from_article()
  from public, anon, authenticated;
revoke all on function public.clear_satisfied_automatic_writing_focus_from_item()
  from public, anon, authenticated;
grant execute on function public.clear_satisfied_automatic_writing_focus(uuid) to service_role;

comment on function public.clear_satisfied_automatic_writing_focus(uuid) is
  'Clears only finish-first pauses proven obsolete because automatic writing is already satisfied.';
comment on function public.content_writing_automation_schema_version() is
  'Returns schema version 12 with obsolete automatic-writing focus pauses cleared.';

notify pgrst, 'reload schema';

commit;
