/* ============================================================
   Skore Party — config.js
   Supabase client. The anon key is designed to be public;
   Row Level Security on the server is the real boundary.
   ============================================================ */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://esplnvjwdvlnhdtnmdiz.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzcGxudmp3ZHZsbmhkdG5tZGl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MzI4MTAsImV4cCI6MjA5ODMwODgxMH0.H0bdShHeL59p8ql0LAuL8991VGGFtXyYbCl1GjWSC8g';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
