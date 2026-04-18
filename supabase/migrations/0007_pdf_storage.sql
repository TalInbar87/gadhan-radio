-- 0007_pdf_storage.sql
-- Switch signing PDFs from Google Drive to Supabase Storage.
-- Reason: SAs have no Drive quota, so uploads to a personal-Drive parent folder
-- always fail with 403 storageQuotaExceeded. Supabase Storage avoids this entirely.

-- 1. Public bucket — security model is "unguessable UUID path" (same as the
--    previous "anyone with the Drive link can view" model the user accepted).
insert into storage.buckets (id, name, public)
  values ('signing-pdfs', 'signing-pdfs', true)
  on conflict (id) do nothing;

-- service_role (used by the Edge Function) bypasses storage policies, so no
-- explicit upload policy is required. Public buckets serve reads to anon by
-- default, so no read policy is required either.

-- 2. Rename columns from the Drive era — the field now holds a full URL.
alter table soldiers rename column pdf_drive_file_id to pdf_url;
alter table signings rename column pdf_drive_file_id to pdf_url;

-- 3. Drop the now-unused Drive folder cache on units.
alter table units drop column if exists drive_folder_id;
