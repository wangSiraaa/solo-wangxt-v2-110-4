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
6. **观察包接入与覆盖审阅**：运营脱敏的本地访问观察包可导入比对——
   真实被访问过的旧址是否已被当前迁移覆盖（见下节）。

## 观察包接入与覆盖审阅

运营提供的脱敏观察包（本地记录，**不是**验证器访问外网的许可）导入后，
系统回答“真实被访问过的旧址是否已被当前迁移覆盖”：

1. **每批记录完整留证**：稳定事件标识、原始 URL（原始路径、百分号编码、
   追踪参数值原样保留，绝不 decode 合并）、时间范围、次数、内容摘要、
   导入时的映射版本；汇总计算不丢证据（同一归一键下的每种原始写法都可展开追溯）。
2. **覆盖按现有规范化规则计算**：`covered`（有生效映射且裁决 ok / deleted_gone_ok，
   含 410 栏目正确消亡）/ `blocked`（验证未过或歧义）/ `unverified`（有映射无裁决）
   / `unmapped`（无映射）。
3. **幂等**：批次按 `batch_key` + 内容摘要（同键同摘要重传 = no-op，同键不同摘要 = 409）；
   事件按稳定 `event_id` 去重——同一事件或同一包重传不会把访问次数翻倍；
   迟到记录按自身观察窗口归入正确时间段。
4. **外网/格式错误记录只隔离**：标记为不可验证并给出原因，**绝不发起请求**
   （观察接入代码路径不含任何 HTTP 客户端，有测试把守）。
5. **版本绑定**：覆盖报告导出即不可变快照，绑定导出时的映射/规则版本；
   映射或规则升级后旧报告仍可复盘，`/api/coverage/reports/:id/diff`
   另行计算当前版本差异——新增未覆盖、已覆盖（含新增覆盖）、
   因规则差异无法比较的项（其新键不会被误计为新增）。

```bash
npm run obs:import              # 导入内置演示观察包（正常旧址/410 栏目/不同 utm/外网/格式错误）
npm run obs:import -- --sample-late   # 迟到补传包（含重复事件，演示幂等）
node scripts/import-observations.js path/to/pkg.json   # 导入指定观察包
```

观察包格式：

```json
{
  "batch_key": "ops-2026-W39-site-a",
  "source_label": "运营脱敏导出 · 2026 第 39 周",
  "records": [
    { "event_id": "evt-0001", "url": "http://127.0.0.1:4568/news/123?utm_source=weibo",
      "window_start": "2026-09-24T10:00:00Z", "window_end": "2026-09-24T11:00:00Z",
      "hits": 12, "content_digest": "sha256:...（可省略，省略时按内容计算）" }
  ]
}
```

## 快速开始

本仓库在无 root 环境中携带了从 Debian 官方包解压的 PostgreSQL 15（arm64，
位于 `tools/`）。如目录不存在，见文末“自备 PostgreSQL”。

```bash
npm install
npm run pg:start        # 启动 tools/ 下的本地 PostgreSQL（127.0.0.1:55432）
npm run migrate         # 建库 + 建表
npm run seed            # 写入 10 条演示录入（含全部异常场景）

npm test                # 33 项测试：规范化规则 + 验证器集成 + 观察包接入/覆盖/版本差异
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

## API 摘要

| 方法/路径 | 作用 |
|---|---|
| `POST /api/normalize` | 规范化试算（不写库） |
| `GET/POST /api/mappings` | 原始录入材料 / 录入一条（自动重算生效与冲突） |
| `POST /api/verify` | 对全部（或指定 `source_norm`）真实验证 |
| `GET /api/crawl/:key` | 查看某条链接的逐跳证据 |
| `GET/POST /api/plans`、`POST /api/plans/:id/build`、`POST /api/plans/:id/publish` | 方案与发布闸门 |
| `POST /api/observations/import` | 导入观察包（批次摘要 + 事件标识幂等；外网/格式错误隔离不请求） |
| `GET /api/observations/batches`、`GET /api/observations/events` | 批次列表 / 原始记录追溯 |
| `GET /api/observations/sample` | 演示观察包（`?late=1` 为迟到补传包） |
| `GET /api/coverage`、`GET /api/coverage/summary` | 实时覆盖（当前规则+映射+裁决）/ 轻量汇总 |
| `POST /api/coverage/reports`、`GET /api/coverage/reports[/:id]` | 导出覆盖快照（绑定版本）/ 复盘历史报告 |
| `GET /api/coverage/reports/:id/diff` | 旧报告（旧版本） vs 当前版本差异 |
| `GET /api/coverage/reports/:id/export?format=csv` | 报告快照 CSV 导出 |
| `GET /api/versions` | 映射/规则版本历史 |

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
              observations.js(观察包分类/覆盖/版本差异·纯函数)
              observation-service.js(幂等落库/报告快照) mapping-versions.js
              observation-sample.js(演示包) fixture.js(随项目本地站点)
              routes.js(Fastify) db.js
server/sql/   schema.sql
web/          Vue 3 + Vite 工作台（总览/证据/方案闸门/覆盖审阅/规则五页）
scripts/      start-pg.js remediate.js report.js import-observations.js
docs/         verification-report-before.md / -after.md（真实跑出来的证据）
server/test/  规则单测 + 验证器集成 + 观察包接入与覆盖（33 项）
```
