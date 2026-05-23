-- Add user_id column for per-user numbering
ALTER TABLE todos ADD COLUMN user_id INTEGER;

-- Populate / renumber user_id with row_number per pubkey (also fixes existing duplicates)
UPDATE todos SET user_id = (
    SELECT COUNT(*) FROM todos t2
    WHERE t2.pubkey = todos.pubkey
    AND t2.id <= todos.id
);

-- Enforce uniqueness so concurrent inserts can never assign the same user_id again
CREATE UNIQUE INDEX IF NOT EXISTS idx_pubkey_user_id_unique ON todos(pubkey, user_id);
