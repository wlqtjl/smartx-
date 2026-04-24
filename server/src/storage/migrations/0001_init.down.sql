-- 0001_init.down.sql
-- 倒序删除，避免外键冲突（当前未建外键，但为后续增加预留顺序）。
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS checkpoints;
DROP TABLE IF EXISTS task_timeline;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS schema_meta;
