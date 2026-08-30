-- Run this SQL in your Supabase SQL Editor:
-- Go to https://supabase.com/dashboard → SQL Editor → New Query → Paste → Run

-- 1. Create exec_sql helper function (needed for future migrations)
CREATE OR REPLACE FUNCTION exec_sql(query TEXT)
RETURNS TEXT AS $$
BEGIN
  EXECUTE query;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Create messages table
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  sender TEXT NOT NULL DEFAULT 'user',
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Enable Row Level Security
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- 4. Create policy for service role access
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'messages' AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON messages
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 5. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
