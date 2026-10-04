-- 旧新映射、爬取结果、迁移方案三类数据，全部带“证据”列。
-- 键的规范化由应用层（WHATWG URL，规则见 config.js）保证，不使用 CITEXT，
-- 因为路径大小写敏感、百分号编码不能随意解码。

-- 每次录入的原始材料（证据），同一归一化键可能有多个不同写法的来源。
CREATE TABLE IF NOT EXISTS mapping_inputs (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,
  source_norm     TEXT NOT NULL,           -- 归一化后的查表键
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  note            TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mapping_inputs_norm ON mapping_inputs(source_norm);

-- 生效映射：source_norm 唯一。同键不同目标的冲突不允许静默覆盖，
-- 由应用层写入并标记（见 ambiguity.js），冲突行 status='conflicted' 不生效。
CREATE TABLE IF NOT EXISTS url_mappings (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,           -- 首次建立该键时的原始地址（证据）
  source_norm     TEXT NOT NULL UNIQUE,
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','conflicted')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 歧义（多旧址归一后相同，却指向不同资源）：
-- 以 mapping_inputs 为证据，按归一化键分组，存在 2 个以上不同 target_norm。
CREATE OR REPLACE VIEW mapping_ambiguities AS
SELECT source_norm,
       count(*) AS input_count,
       count(DISTINCT target_norm) AS target_variants,
       array_agg(DISTINCT source_raw ORDER BY source_raw) AS source_forms,
       array_agg(DISTINCT target_raw ORDER BY target_raw) AS targets
FROM mapping_inputs
GROUP BY source_norm
HAVING count(DISTINCT target_norm) > 1;

CREATE TABLE IF NOT EXISTS crawl_results (
  id                  BIGSERIAL PRIMARY KEY,
  source_norm         TEXT NOT NULL,
  hop_index           INT  NOT NULL,           -- 0 = 入口地址
  url_raw             TEXT NOT NULL,           -- 该跳实际请求的原始 URL
  url_norm            TEXT NOT NULL,           -- 该跳规范化形式
  status_code         INT,
  location_raw        TEXT,                    -- 响应 Location（原样保留）
  location_norm       TEXT,
  is_redirect         BOOLEAN NOT NULL DEFAULT false,
  fetch_error         TEXT,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_norm, hop_index)
);

-- 对每个入口地址的最终裁决（最终页面状态必须核实）
CREATE TABLE IF NOT EXISTS verification_verdicts (
  source_norm         TEXT PRIMARY KEY,
  source_raw          TEXT NOT NULL,
  final_url_raw       TEXT,
  final_url_norm      TEXT,
  final_status        INT,
  hops                INT  NOT NULL DEFAULT 0,
  tracker_preserved   BOOLEAN,                 -- 追踪参数是否到达最终 URL
  -- ok / redirect_loop / chain_too_long / fetch_error /
  -- deleted_gone_ok / deleted_not_gone / ambiguity / final_status_bad
  verdict             TEXT NOT NULL,
  issues              JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 迁移方案：填表只是 pending，验证通过才 allowed 发布。
CREATE TABLE IF NOT EXISTS migration_plans (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','ready','published')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS migration_plan_items (
  id              BIGSERIAL PRIMARY KEY,
  plan_id         BIGINT NOT NULL REFERENCES migration_plans(id) ON DELETE CASCADE,
  mapping_id      BIGINT NOT NULL REFERENCES url_mappings(id),
  -- pending（仅填表） / verified（有验证证据） / blocked（存在问题）
  item_status     TEXT NOT NULL DEFAULT 'pending'
                  CHECK (item_status IN ('pending','verified','blocked')),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (plan_id, mapping_id)
);

-- ---------------------------------------------------------------------------
-- 观察包接入与覆盖审阅
-- ---------------------------------------------------------------------------

-- 映射/规则版本：生效映射集或规范化规则任一变化即产生新版本（懒式创建）。
-- 历史覆盖报告绑定导出时的版本行；快照保存当时的规则原文与映射集，供复盘。
CREATE TABLE IF NOT EXISTS mapping_versions (
  id                BIGSERIAL PRIMARY KEY,
  rules_fingerprint TEXT NOT NULL,           -- 规范化规则指纹（尾斜杠模式、追踪参数集…）
  mapping_digest    TEXT NOT NULL,           -- 生效映射集摘要
  rules_snapshot    JSONB NOT NULL,          -- 规则原文（复盘用）
  mapping_snapshot  JSONB NOT NULL,          -- 生效映射快照（复盘用）
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rules_fingerprint, mapping_digest)
);

-- 运营观察包（脱敏本地访问记录），整包幂等：
-- 同 batch_key + 同内容摘要的重传是 no-op；同键不同摘要拒绝（409），不静默覆盖。
CREATE TABLE IF NOT EXISTS observation_batches (
  id                 BIGSERIAL PRIMARY KEY,
  batch_key          TEXT NOT NULL UNIQUE,   -- 提供方给的稳定批次标识
  source_label       TEXT,                   -- 提供方/说明
  batch_digest       TEXT NOT NULL,          -- 整包内容摘要（由记录摘要聚合）
  record_count       INT  NOT NULL,
  mapping_version_id BIGINT REFERENCES mapping_versions(id), -- 导入时的映射版本
  raw_payload        JSONB NOT NULL,         -- 原始包全文（证据）
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 观察事件：稳定事件标识全局唯一 —— 重复/迟到记录按 event_id 幂等，
-- 同一事件重传不会把访问次数翻倍；迟到记录按自身 window 归入正确时间段。
CREATE TABLE IF NOT EXISTS observation_events (
  id                BIGSERIAL PRIMARY KEY,
  batch_id          BIGINT NOT NULL REFERENCES observation_batches(id) ON DELETE CASCADE,
  event_id          TEXT NOT NULL UNIQUE,    -- 稳定事件标识
  url_raw           TEXT NOT NULL,           -- 原始 URL：原样保留路径/百分号编码/追踪参数值
  window_start      TIMESTAMPTZ,             -- 观察时间范围（结构非法的记录允许为空并被隔离）
  window_end        TIMESTAMPTZ,
  hits              INT  CHECK (hits >= 0),  -- 观察次数
  content_digest    TEXT NOT NULL,           -- 记录内容摘要
  norm_key          TEXT,                    -- 导入时按当时规则计算的查表键（留证；
                                             --   覆盖计算在查询时按当前规则重算）
  pathname_raw      TEXT,                    -- 原始路径（百分号编码原样，不 decode）
  query_raw         TEXT,                    -- 原始查询串（含全部追踪参数值）
  tracker_params    JSONB NOT NULL DEFAULT '{}'::jsonb, -- 追踪参数名→值（证据）
  status            TEXT NOT NULL DEFAULT 'observed'
                    CHECK (status IN ('observed','quarantined')),
  -- 外网/非白名单 origin、URL 格式错误、记录结构非法 → quarantined：
  -- 只标记为不可验证，绝不对其发起任何请求
  quarantine_reason TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_observation_events_norm   ON observation_events(norm_key);
CREATE INDEX IF NOT EXISTS idx_observation_events_window ON observation_events(window_start);
CREATE INDEX IF NOT EXISTS idx_observation_events_status ON observation_events(status);

-- 覆盖报告：导出即快照，绑定映射版本。
-- 迟到记录只影响实时覆盖与后续导出，绝不回写已导出的历史版本报告。
CREATE TABLE IF NOT EXISTS coverage_reports (
  id                 BIGSERIAL PRIMARY KEY,
  title              TEXT,
  mapping_version_id BIGINT NOT NULL REFERENCES mapping_versions(id),
  summary            JSONB NOT NULL,         -- 汇总（各状态键数/命中数）
  items              JSONB NOT NULL,         -- 覆盖项快照（含原始 URL 证据）
  quarantined        JSONB NOT NULL,         -- 隔离项快照（含原因）
  timeline           JSONB NOT NULL DEFAULT '[]'::jsonb, -- 时间段快照（迟到记录不回写）
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
