-- Daily counters only. One row per (UTC day, counter name); no install, request or IP data.
-- Names: checks, new, week, month, v:<version>, channel:<channel>, arch:<arch>.
CREATE TABLE IF NOT EXISTS counter (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
) WITHOUT ROWID;
