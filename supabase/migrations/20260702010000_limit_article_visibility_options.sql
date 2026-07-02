-- Keep article visibility choices aligned with the dashboard and n8n API.
-- Existing shared/team rows are converted to public before tightening the check.

update public.articles
set visibility = 'public'
where visibility in ('shared', 'team');

alter table public.articles
drop constraint if exists articles_visibility_check;

alter table public.articles
add constraint articles_visibility_check
check (visibility in ('private', 'public'));

