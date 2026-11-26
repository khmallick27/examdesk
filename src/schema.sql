-- ExamDesk schema. Idempotent: safe to run on every start.
CREATE TABLE IF NOT EXISTS faculty (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  department    TEXT NOT NULL DEFAULT 'Department of Electrical Engineering',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'faculty' CHECK (role IN ('admin','faculty')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS faculty_sessions (
  token_hash  TEXT PRIMARY KEY,
  faculty_id  INT NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exams (
  id              SERIAL PRIMARY KEY,
  owner_id        INT NOT NULL REFERENCES faculty(id),
  title           TEXT NOT NULL,
  session_label   TEXT NOT NULL DEFAULT '',
  academic_year   TEXT NOT NULL DEFAULT '',
  department      TEXT NOT NULL DEFAULT 'Department of Electrical Engineering',
  instructions    TEXT NOT NULL DEFAULT '',
  code            TEXT NOT NULL UNIQUE,
  slug            TEXT NOT NULL UNIQUE,
  duration_min    INT NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 1 AND 600),
  marks_per_q     NUMERIC(6,2) NOT NULL DEFAULT 1,
  negative_marks  NUMERIC(6,2) NOT NULL DEFAULT 0,
  start_at        TIMESTAMPTZ,
  end_at          TIMESTAMPTZ,
  shuffle         BOOLEAN NOT NULL DEFAULT FALSE,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id         SERIAL PRIMARY KEY,
  exam_id    INT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  position   INT NOT NULL,
  stem       TEXT NOT NULL,                 -- sanitized HTML
  options    JSONB NOT NULL,                -- array of 4 sanitized HTML strings
  correct    SMALLINT CHECK (correct BETWEEN 0 AND 3),   -- NULL until faculty sets it
  suggested  SMALLINT CHECK (suggested BETWEEN 0 AND 3), -- answer printed in the document; never used for scoring
  approved   BOOLEAN NOT NULL DEFAULT FALSE,
  marks      NUMERIC(6,2),                  -- NULL = exam default
  negative   NUMERIC(6,2),                  -- NULL = exam default
  flags      JSONB NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL DEFAULT 'manual'
);
-- GATE-style numerical answer type: the key is an inclusive range [nat_min, nat_max].
ALTER TABLE questions ADD COLUMN IF NOT EXISTS qtype TEXT NOT NULL DEFAULT 'mcq' CHECK (qtype IN ('mcq','nat'));
ALTER TABLE questions ADD COLUMN IF NOT EXISTS nat_min NUMERIC(12,2);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS nat_max NUMERIC(12,2);
CREATE INDEX IF NOT EXISTS questions_exam_idx ON questions(exam_id, position);

CREATE TABLE IF NOT EXISTS attempts (
  id                 SERIAL PRIMARY KEY,
  exam_id            INT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  receipt_no         TEXT NOT NULL UNIQUE,
  student_name       TEXT NOT NULL,
  roll_no            TEXT NOT NULL,
  session_token_hash TEXT,
  question_order     JSONB NOT NULL,
  answers            JSONB NOT NULL DEFAULT '{}',
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at        TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at       TIMESTAMPTZ,
  submit_mode        TEXT,                  -- manual | timeout
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','submitted')),
  attempted          INT, correct_count INT, incorrect_count INT, unanswered INT,
  score              NUMERIC(8,2), max_score NUMERIC(8,2),
  warnings           INT NOT NULL DEFAULT 0,
  ip                 TEXT, user_agent TEXT,
  UNIQUE (exam_id, roll_no)                 -- one attempt per roll number per exam
);
CREATE INDEX IF NOT EXISTS attempts_active_idx ON attempts(status, deadline_at);

CREATE TABLE IF NOT EXISTS attempt_events (
  id          BIGSERIAL PRIMARY KEY,
  attempt_id  INT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attempt_events_idx ON attempt_events(attempt_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL PRIMARY KEY,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT '',
  ip      TEXT,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
