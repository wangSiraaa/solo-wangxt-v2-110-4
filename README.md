# URL 迁移验证工作台（Vue 3 + Fastify + PostgreSQL）

内容平台更换栏目结构时，技术负责人需要回答一个问题：**旧链接最终会落到哪里、最终页面状态是什么**。
本项目把“填映射表”和“迁移完成”严格区分开——每条映射只有经过真实 HTTP 请求验证、
拿到逐跳证据并通过发布闸门，才允许发布。

## 它保证了什么

1. **WHATWG URL 规范化**（`server/src/normalize.js`），规则集中、显式：
   - 路径**大小写敏感**：`/News/123` ≠ `/news/123`；
   - 百分号编码只统一十六进制大小写（`%2f→%2F`），**绝不 decode 后合并**；
     原始中文按 UTF-8 编码，`/a%2Fb` 与 `/a/b` 是不同资源；
   - **尾斜杠保留**：`/column/weekly/` ≠ `/column/weekly`；
   - 查询参数：非追踪参数参与资源身份；追踪参数（utm_*、gclid 等）不参与身份，
     但迁移跳转时**原样带到最终 URL**；fragment 丢弃。
2. **只验证随项目启动的本地站点**：白名单 `127.0.0.1:4568`，每一跳的 `Location`
   重新解析并重新过白名单，外网/其它端口一律拒绝（防 SSRF，见 `server/src/verifier.js`）。
3. **检测重定向环、过长链（>5 跳）、多旧址归一后的歧义**：
   - 环：归一化 URL 在同链中重复即停；
   - 长链：超过预算仍给 Location 即 `chain_too_long`；
   - 歧义：多个录入归一到同一键却指向不同目标 → `conflicted`，不挑赢家、阻断发布。
4. **最终页面状态必须核实**：普通迁移期望最终 2xx 且落点严格等于映射目标；
   已删除栏目期望 **410 Gone**（接受 404），不允许 301 到首页蒙混。
5. **PostgreSQL 保存三类数据**：旧新映射（原始材料 `mapping_inputs` + 生效表
   `url_mappings`）、爬取逐跳结果（`crawl_results`）、迁移方案（`migration_plans`
   / `migration_plan_items`），另存每入口最终裁决 `verification_verdicts`。
6. **观察包接入与覆盖审阅**：运营脱敏的本地访问观察包可整包导入
   （`observation_batches` / `observation_events`），系统用同一套规范化规则
   计算“真实被访问的旧址是否已被迁移覆盖”（`coverage_reports` 快照 +
   `mapping_versions` 版本绑定）。观察记录**不是**访问外网的许可：
   外网/格式错误记录只隔离标记，验证器绝不发起请求。

## 快速开始

本仓库在无 root 环境中携带了从 Debian 官方包解压的 PostgreSQL 15（arm64，
位于 `tools/`）。如目录不存在，见文末“自备 PostgreSQL”。

```bash
npm install
npm run pg:start        # 启动 tools/ 下的本地 PostgreSQL（127.0.0.1:55432）
npm run migrate         # 建库 + 建表
npm run seed            # 写入 10 条演示录入（含全部异常场景）

npm test                # 24 项测试：规范化规则 + 验证器集成 + 观察包覆盖集成
npm run verify          # CLI：对全部映射真实请求验证并给出裁决
node scripts/report.js  # 产出 docs/verification-report-before.md 风格的证据报告

npm start               # 本地站点 + API + 已构建的前端
                        # 工作台 http://127.0.0.1:4567 （仅监听 127.0.0.1）
```

前端开发模式：`npm run dev:web`（Vite :5173，`/api` 代理到 4567）。

## 演示场景（`server/src/seed.js` + `server/src/fixture.js`）

| 场景 | 旧址 | 预期 |
|---|---|---|
| 编码中文路径 + 追踪参数 | `/频道/科技/42.html?utm_source=weibo` | 301→新页 200，追踪参数保留 |
| 正确小写路径 | `/news/123` | 通过 |
| 尾斜杠是身份 | `/column/weekly/` | 通过；无斜杠写法 404 |
| 编码斜杠 | `/old-files%2Fdraft` | 通过；`/files/draft` 是另一个资源（404） |
| 已删除栏目 | `/forum/announce/9` | **410 Gone** |
| 重定向环 | `/loop/a ↔ /loop/b` | `redirect_loop` |
| 过长链（7 跳） | `/chain/0 … /chain/7` | `chain_too_long` |
| 归一化歧义 | 同键 `/news/123` 指向 123 与 999 | `ambiguity`，不生效不请求 |
| 外网地址 | `http://example.com/...` | 白名单拒绝，**不发起请求** |
| 大小写错误 | `/News/123` | 最终 404，验证失败 |

## “填完表 ≠ 迁移完成”的完整闭环

```bash
# 1) 整改前：验证失败、报告记录受影响链接与证据（docs/verification-report-before.md）
npm run seed && npm run verify
#  → 共 9 条，通过 4，阻断 5（环/长链/404/歧义/越权）

# 2) 业务与运维修复：
#    - 站点侧打断环、长链改直跳（FIXTURE_MODE=fixed 模拟已上线配置）
#    - scripts/remediate.js：裁决歧义、剔除错误录入和非本站地址、更新映射目标
FIXTURE_MODE=fixed node scripts/remediate.js
FIXTURE_MODE=fixed npm run verify
#  → 共 7 条，全部通过（含 1 条已删除正确 410）

# 3) 整改后证据报告
FIXTURE_MODE=fixed node scripts/report.js
#  → docs/verification-report.md（passed=7 blocked=0）
```

工作台里的“迁移方案”也遵循同样闸门：纳入方案只是 `pending`，
`build` 时按最新裁决标注 `verified/blocked`；`publish` 时只要存在
blocked/pending、未纳入的生效映射或未裁决歧义，就返回 **409 + 受影响链接清单**。

## 观察包与覆盖审阅

运营提供的脱敏观察包（每批一个 `batch_key` + 记录数组）回答另一个问题：
**真实被访问过的旧址，当前迁移覆盖了吗？**

```bash
curl -X POST http://127.0.0.1:4567/api/observations/import \
  -H 'content-type: application/json' -d '{
    "batch_key": "ops-2026-w40",
    "records": [{
      "event_id": "w40-001",                              # 稳定事件标识（幂等键）
      "url": "http://127.0.0.1:4568/news/123?utm_source=weibo",
      "observed_start": "2026-09-28T08:00:00Z",           # 观察时间范围
      "observed_end":   "2026-09-28T09:00:00Z",
      "hits": 64,                                          # 次数
      "content_digest": "sha256:..."                       # 内容摘要
    }]
  }'
```

纪律与保证：

1. **证据不丢失**：`raw_url` 原样保存（原始路径、百分号编码、追踪参数值），
   追踪参数另存 `tracker_params`；覆盖只按归一键汇总，原始记录永远可追溯。
2. **幂等**：同一 `(batch_key, digest)` 重传直接命中不重复计数；同一 `event_id`
   跨批次重传（内容一致）记 duplicate；同标识不同内容记冲突并保留首次记录；
   同 `batch_key` 不同摘要 → **409** 拒绝。访问次数绝不因重传翻倍。
3. **隔离而非请求**：外网/非白名单 origin 标记 `external`、格式错误标记
   `invalid`，只写隔离原因，验证器对它们**零请求**（覆盖计算只读映射与裁决，
   本身就不发起任何 HTTP 请求）。
4. **迟到记录**：按 `observed_start` 归入正确时间段；已导出的报告是
   不可变快照，迟到记录只体现在“与当前版本的差异”里，不改写历史。
5. **版本绑定**：映射或规范化规则每次变化产生新的 `mapping_versions`
   （规则指纹 + 映射集快照）。历史报告绑定旧版本可复盘；新报告在导出时
   固化与上一报告的差异——**新增未覆盖 / 新增已覆盖 / 因规则差异无法比较**
   （事件规则指纹与当前版本不一致时不强行比较，避免假覆盖）。

```bash
curl http://127.0.0.1:4567/api/coverage/current          # 当前覆盖（实时）
curl -X POST http://127.0.0.1:4567/api/coverage/reports \
  -H 'content-type: application/json' -d '{"note":"周度快照"}'   # 导出报告
curl http://127.0.0.1:4567/api/coverage/reports/1/diff   # 旧报告 vs 当前版本
```

前端「观察包与覆盖」页提供导入、当前覆盖、报告导出/复盘/版本比较；
「验证总览」与「迁移方案」页展示未覆盖热点等风险提示。

## API 摘要

| 方法/路径 | 作用 |
|---|---|
| `POST /api/normalize` | 规范化试算（不写库） |
| `GET/POST /api/mappings` | 原始录入材料 / 录入一条（自动重算生效与冲突） |
| `POST /api/verify` | 对全部（或指定 `source_norm`）真实验证 |
| `GET /api/crawl/:key` | 查看某条链接的逐跳证据 |
| `GET/POST /api/plans`、`POST /api/plans/:id/build`、`POST /api/plans/:id/publish` | 方案与发布闸门 |
| `POST /api/observations/import` | 导入观察包（批次摘要 + 事件标识幂等，外网/错格式隔离） |
| `GET /api/observations/batches`、`GET /api/observations/events` | 批次与原始记录（可追溯，支持时间段/隔离过滤） |
| `GET /api/coverage/current` | 当前覆盖（当前映射版本 + 最新裁决，实时计算） |
| `POST /api/coverage/reports`、`GET /api/coverage/reports[/:id]` | 导出不可变报告快照 / 复盘 |
| `GET /api/coverage/reports/:id/diff` | 旧报告绑定版本 vs 当前版本的差异 |
| `GET /api/mapping-versions` | 映射版本列表（规则指纹 + 快照） |

## 环境变量（见 `.env.example`）

`HOST/PORT`（API）、`FIXTURE_HOST/PORT`（本地站点）、`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`、
`TRAILING_SLASH_MODE`（默认 `keep`）、`MAX_REDIRECTS`（默认 5）、`HTTP_TIMEOUT_MS`、
`FIXTURE_MODE`（`fixed` = 模拟整改后站点）。

## 自备 PostgreSQL

若 `tools/` 不存在，在 Debian/Ubuntu 上可由无 root 方式取得二进制：

```bash
mkdir -p tools/pg-debs && cd tools/pg-debs
curl -O http://deb.debian.org/debian/pool/main/p/postgresql-15/postgresql-15_15.18-0+deb12u1_arm64.deb
curl -O http://deb.debian.org/debian/pool/main/p/postgresql-15/postgresql-client-15_15.18-0+deb12u1_arm64.deb
mkdir pg && cd pg && ar x ../postgresql-15_*.deb && tar xf data.tar.xz
cd .. && mkdir pg-client && cd pg-client && ar x ../postgresql-client-15_*.deb && tar xf data.tar.xz
cd /workspace && npm run pg:start
```

其它架构（amd64 等）把 deb 文件名中的 `arm64` 替换即可。也可改用系统 PostgreSQL，
用上述 `PG*` 环境变量指向它（脚本不会触碰你已有的实例，只创建 `url_migration` 库）。

## 目录

```
server/src/   normalize.js(规范化规则) verifier.js(白名单/环/长链/最终状态)
              ambiguity.js mappings-service.js verify-runner.js
              fingerprint.js(规则/内容指纹) observations-core.js(记录分类)
              observations-service.js(幂等导入) coverage-core.js(覆盖/差异)
              coverage-service.js(查询/导出) mapping-versions.js(版本)
              fixture.js(随项目本地站点) routes.js(Fastify) db.js
server/sql/   schema.sql
web/          Vue 3 + Vite 工作台（总览/证据/方案闸门/观察包与覆盖/规则五页）
scripts/      start-pg.js remediate.js report.js
docs/         verification-report-before.md / -after.md（真实跑出来的证据）
server/test/  规则单测 + 验证器集成 + 观察包覆盖集成（24 项）
```
