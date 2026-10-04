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

-- ============ 观察包接入与覆盖审阅 ============

-- 映射版本：映射集或规范化规则每次变化都产生一个不可变版本。
-- 历史覆盖报告绑定版本（含全量快照），旧版本永远可复盘；当前版本继续演进。
CREATE TABLE IF NOT EXISTS mapping_versions (
  id                BIGSERIAL PRIMARY KEY,
  version_no        INT  NOT NULL UNIQUE,
  rules_fingerprint TEXT NOT NULL,        -- 规范化规则指纹（规则升级即变）
  snapshot_hash     TEXT NOT NULL,        -- 规则指纹 + 映射集内容摘要
  snapshot          JSONB NOT NULL,       -- 生效映射全量快照（复盘证据）
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 观察包批次：同一 (batch_key, digest) 重传幂等；同 key 不同 digest 拒绝。
CREATE TABLE IF NOT EXISTS observation_batches (
  id                   BIGSERIAL PRIMARY KEY,
  batch_key            TEXT NOT NULL,     -- 运营提供的稳定批次标识
  digest               TEXT NOT NULL,     -- 批次内容摘要（canonical 记录 sha256）
  record_count         INT  NOT NULL,
  accepted_count       INT  NOT NULL DEFAULT 0,
  duplicate_count      INT  NOT NULL DEFAULT 0,
  quarantined_count    INT  NOT NULL DEFAULT 0,
  conflict_count       INT  NOT NULL DEFAULT 0,
  mapping_version_id   BIGINT REFERENCES mapping_versions(id),  -- 导入时的当前版本
  note                 TEXT,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_key, digest)
);

-- 观察事件：原始记录即证据。raw_url 原样保存（原始路径、百分号编码、
-- 追踪参数值），绝不因汇总而丢失；隔离记录同样保存并标注原因，
-- 但绝不进入验证流程（外网/非法 origin 不会触发任何请求）。
CREATE TABLE IF NOT EXISTS observation_events (
  id                   BIGSERIAL PRIMARY KEY,
  event_id             TEXT NOT NULL UNIQUE,  -- 稳定事件标识（幂等键）
  batch_id             BIGINT NOT NULL REFERENCES observation_batches(id),
  record_fingerprint   TEXT NOT NULL,         -- 单条内容指纹（同 id 不同内容=冲突）
  raw_url              TEXT NOT NULL,         -- 原始 URL，原样保留
  norm_key             TEXT,                  -- 导入时规则下的查表键（invalid 时为空）
  rules_fingerprint    TEXT,                  -- 计算 norm_key 所用规则指纹
  origin_class         TEXT NOT NULL CHECK (origin_class IN ('local','external','invalid')),
  quarantine_reason    TEXT,                  -- 隔离原因；local 为 NULL
  tracker_params       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 追踪参数名→值（原样）
  observed_start       TIMESTAMPTZ,           -- 观察时间范围（隔离记录可空）
  observed_end         TIMESTAMPTZ,
  hits                 INT  NOT NULL DEFAULT 0,
  content_digest       TEXT,                  -- 运营侧内容摘要
  mapping_version_id   BIGINT REFERENCES mapping_versions(id),  -- 导入时版本
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_obs_events_norm ON observation_events(norm_key);
CREATE INDEX IF NOT EXISTS idx_obs_events_observed ON observation_events(observed_start);
CREATE INDEX IF NOT EXISTS idx_obs_events_batch ON observation_events(batch_id);

-- 覆盖报告：导出即不可变快照，绑定映射版本。
-- 后续导入（含迟到记录）、映射变更、规则升级都不改写它。
CREATE TABLE IF NOT EXISTS coverage_reports (
  id                 BIGSERIAL PRIMARY KEY,
  mapping_version_id BIGINT NOT NULL REFERENCES mapping_versions(id),
  range_start        TIMESTAMPTZ,
  range_end          TIMESTAMPTZ,
  summary            JSONB NOT NULL,   -- 计数汇总 + 与上一报告的差异（导出时固化）
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coverage_report_items (
  id                BIGSERIAL PRIMARY KEY,
  report_id         BIGINT NOT NULL REFERENCES coverage_reports(id) ON DELETE CASCADE,
  event_id          TEXT NOT NULL,
  raw_url           TEXT NOT NULL,     -- 原始 URL 快照（证据）
  norm_key          TEXT,
  rules_fingerprint TEXT,              -- 事件归一所用规则指纹（差异判定依据）
  coverage          TEXT NOT NULL,     -- covered/uncovered/unverifiable/incomparable/...
  verdict           TEXT,              -- 导出时的验证裁决
  hits              INT  NOT NULL DEFAULT 0,
  observed_start    TIMESTAMPTZ,
  observed_end      TIMESTAMPTZ,
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_cover_items_report ON coverage_report_items(report_id);
