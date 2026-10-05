-- A failed automatic-writing session may be resumed explicitly from the
-- editor after its queue item has been cancelled. The resumed session keeps
-- its original queue link for audit history, but it must no longer reconcile
-- terminal status changes back into that superseded automatic run.
create or replace function public.sync_content_writing_automation_session()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item_id uuid;
begin
  if new.status not in ('completed', 'failed', 'cancelled')
     or new.status is not distinct from old.status then
    return new;
  end if;

  if coalesce(new.context_snapshot ->> 'triggerSource', '') <> 'automatic_ready' then
    return new;
  end if;

  select item.id
  into v_item_id
  from public.content_writing_automation_items as item
  where item.content_writing_session_id = new.id;
  if v_item_id is null then
    return new;
  end if;

  perform public.reconcile_content_writing_automation_session(v_item_id, new.id);

  return new;
end;
$$;

revoke all on function public.sync_content_writing_automation_session() from public, anon, authenticated;

comment on function public.sync_content_writing_automation_session() is
  'Reconciles terminal automatic-writing sessions while leaving explicitly resumed sessions detached from their superseded queue run.';
