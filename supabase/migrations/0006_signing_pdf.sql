-- 0006_signing_pdf.sql
-- Track Google Drive PDF uploads per signing/soldier and cache per-unit Drive folder ids.

alter table signings
  add column if not exists pdf_drive_file_id text;

alter table soldiers
  add column if not exists pdf_drive_file_id text;

alter table units
  add column if not exists drive_folder_id text;
