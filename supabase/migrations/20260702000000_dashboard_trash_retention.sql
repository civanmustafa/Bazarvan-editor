create or replace function public.purge_expired_dashboard_trash(
  retention_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id text := auth.uid()::text;
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 1));
  deleted_count integer := 0;
  cleaned_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  delete from public.articles a
  where (a.metadata->'trash'->>'deletedAt')::timestamptz < cutoff
    and (
      public.is_admin()
      or a.owner_id = auth.uid()
      or a.created_by = auth.uid()
    );
  get diagnostics deleted_count = row_count;

  update public.articles a
  set metadata = case
    when jsonb_typeof((a.metadata #- array['trash', 'deletedFor', current_user_id])->'trash'->'deletedFor') = 'object'
      and ((a.metadata #- array['trash', 'deletedFor', current_user_id])->'trash'->'deletedFor') <> '{}'::jsonb
      then a.metadata #- array['trash', 'deletedFor', current_user_id]
    when jsonb_typeof((a.metadata #- array['trash', 'deletedFor', current_user_id])->'trash') = 'object'
      and ((a.metadata #- array['trash', 'deletedFor', current_user_id])->'trash') <> '{}'::jsonb
      then (a.metadata #- array['trash', 'deletedFor', current_user_id]) #- '{trash,deletedFor}'
    else (a.metadata #- array['trash', 'deletedFor', current_user_id]) #- '{trash}'
  end
  where ((a.metadata #>> array['trash', 'deletedFor', current_user_id, 'deletedAt'])::timestamptz) < cutoff;
  get diagnostics cleaned_count = row_count;

  return deleted_count + cleaned_count;
end;
$$;

grant execute on function public.purge_expired_dashboard_trash(integer) to authenticated;
