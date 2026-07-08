-- Instance capacity (ARCHITECTURE §6.2). The game version defines how many
-- players an instance seats; the join flow enforces it.
ALTER TABLE game_version
  ADD COLUMN max_players INTEGER NOT NULL DEFAULT 2 CHECK (max_players >= 1);
