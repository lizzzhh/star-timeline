# 星轨Timeline - 社团成员时间线系统

> 感觉 GLM 老师对本项目的大力支持

> 一个基于 **Cloudflare Workers + D1** 的社团成员信息展示与自助修改审核系统。
> 成员通过真实姓名验证后可提交资料修改，由管理员在后台统一审核；个人隐私「只进不出」，全流程无明文存储。

---

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [技术架构](#技术架构)
- [目录结构](#目录结构)
- [快速部署](#快速部署)
- [配置说明](#配置说明)
- [API 概览](#api-概览)
- [安全设计](#安全设计)
- [冒烟测试](#冒烟测试)
- [常见问题](#常见问题)

---

## 项目简介

**星轨Timeline**为动漫创作类社团提供一套轻量的成员档案管理方案：

- 前台展示全体成员的昵称、届别、职位、头像、简介、标签与社交链接；
- 成员本人可凭**真实姓名验证**（5 分钟有效的一次性令牌）发起资料修改申请；
- 修改内容进入后台待审队列，管理员可**通过 / 驳回（需填理由）**，通过后自动应用变更；
- 管理员可在后台增删改查成员、重置登记姓名。
  整个系统仅需一个 Cloudflare Worker 即可承载静态页面 + API + 数据库，零服务器运维成本，免费额度内即可长期稳定运行。

## 功能特性

### 前台（公开）

- ✅ 成员列表展示（含头像、标签、社交链接跳转）
- ✅ 实名验证 → 提交资料修改申请
- ✅ 修改前后对照快照，提交后台待审

### 后台（管理员）

- ✅ 密码登录，2 小时会话有效期，支持服务端吊销
- ✅ 待审核 / 已通过 / 已驳回 三栏队列视图，显示变更 diff 与驳回理由
- ✅ 一键通过 / 驳回（驳回必填理由）
- ✅ 成员管理：新增、编辑（含重置实名）、删除
- ✅ 删除成员时自动作废其 pending 提交（原子级联）

### 安全

- ✅ 真实姓名**双哈希存储**，数据库中永不出现明文
- ✅ 输出接口一律不含 realName 相关字段（即使管理员也不可见）
- ✅ D1 计数窗口限流（429 兜底）
- ✅ 64KB 请求体上限、字段白名单、URL 协议合法性校验

## 技术架构

| 层       | 技术                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 运行时   | Cloudflare Workers                                                        |
| 数据库   | Cloudflare D1（SQLite）                                                   |
| 静态资源 | Workers Assets（`./content` 目录）                                        |
| 密码学   | Web Crypto 内置：SHA-256（确定性查重）、PBKDF2-SHA256 10 万轮（验证比对） |
| 身份凭证 | `verifyToken`（一次性，5 分钟）/ `adminToken`（Bearer，2 小时，可吊销）   |

## 目录结构

```
.
├── src/
│   └── index.js          # Worker 入口：路由 + 全部 API 实现
├── content/
│   └── index.html        # 前台 + 后台单页应用
├── schema.sql            # D1 建表脚本
├── wrangler.toml         # Wrangler 配置
└── README.md
```

## 快速部署

### 1. 安装 Wrangler

```bash
npm i -g wrangler
# 或在项目中：
npm init -y && npm i -D wrangler
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create star-timeline
```

将返回的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "star-timeline"
database_id = "<替换为你实际的 database_id>"
```

### 3. 初始化表结构

```bash
npx wrangler d1 execute star-timeline --remote --file=./schema.sql
```

### 4. 配置 Secrets（务必执行，切勿写入仓库）

```bash
npx wrangler secret put SERVER_PEPPER   # 真实姓名哈希的胡椒，随机长字符串即可
npx wrangler secret put ADMIN_PASSWORD  # 后台登录密码
```

> ⚠️ 这两项不入库、不进代码。若未配置 `ADMIN_PASSWORD`，登录接口会返回 500。

### 5. 部署上线

```bash
npx wrangler deploy
```

完成后访问 `https://<your-worker>.workers.dev/` 即为主页。

## 配置说明

### wrangler.toml 关键项

| 配置项                                 | 说明                           |
| -------------------------------------- | ------------------------------ |
| `main = "src/index.js"`                | Worker 入口文件                |
| `assets = { directory = "./content" }` | 静态资源目录，前端 SPA 所在处  |
| `compatibility_date`                   | 兼容日期                       |
| `d1_databases.binding = "DB"`          | 代码中通过 `env.DB` 访问数据库 |

### Secrets（`wrangler secret put` 注入）

| 名称             | 用途                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `SERVER_PEPPER`  | 参与确定性哈希计算：`SHA-256(realName + PEPPER)`，用于查重/等值查找。**配置后不可更换**，否则所有已登记姓名将无法匹配 |
| `ADMIN_PASSWORD` | 后台明文密码（服务端恒时比较）                                                                                        |

## API 概览

所有响应统一包格式：

```jsonc
// 成功
{ "ok": true,  "data": { ... } }
// 失败
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

### 公开接口

| 方法 | 路径               | 说明                                             | 限流          |
| ---- | ------------------ | ------------------------------------------------ | ------------- |
| GET  | `/api/members`     | 获取全部成员列表（空库返回 `[]`）                | —             |
| POST | `/api/verify-name` | 真实姓名验证，返回一次性 `verifyToken`（5 分钟） | 5 次/分钟/IP  |
| POST | `/api/submissions` | 凭 `verifyToken` 提交修改申请                    | 10 次/小时/IP |

#### 示例：验证姓名

```json
POST /api/verify-name
{ "realName": "张三" }
→ { "ok": true, "data": {
     "memberId": 1,
     "verifyToken": "vt_...",
     "member": { ... }
   }}
```

#### 示例：提交修改

```json
POST /api/submissions
{
  "verifyToken": "vt_...",
  "changes": { "bio": "新的简介", "tags": ["动漫", "画师"] }
}
→ { "ok": true, "data": { "submissionId": 42 } }
```

可修改字段白名单：`name / generation / role / bio / avatar / tags / social`。提交 `realName` 会直接被拒绝（`FIELD_FORBIDDEN`）。校验失败不会消耗令牌。

### 管理接口（除 login 外均需 `Authorization: Bearer <adminToken>`）

| 方法   | 路径                                                        | 说明                                                                                                                                                   |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/api/admin/login`                                          | 登录，返回 `adminToken`（2 小时）                                                                                                                      |
| GET    | `/api/admin/submissions?status=pending\|approved\|rejected` | 分状态列出审核记录（非法 status 返回 `[]`；另有别名 `GET /api/submissions` 同样要求鉴权）                                                              |
| POST   | `/api/admin/submissions/{id}/approve`                       | 通过并应用变更（last-write-wins）；目标成员已被删除时返回 404 拒绝应用                                                                                 |
| POST   | `/api/admin/submissions/{id}/reject`                        | 驳回，**必须携带非空 `reason`**                                                                                                                        |
| GET    | `/api/admin/members`                                        | 成员管理列表（同样不含 realName）                                                                                                                      |
| POST   | `/api/admin/members`                                        | 新增成员（`realName/name/generation` 必填，realName 唯一）                                                                                             |
| PUT    | `/api/admin/members/{id}`                                   | 部分更新：缺省不改、出现即覆盖；tags/social 整体替换；`avatar` 自动补全 `https://`；传非空 `realName` 可重置登记姓名（唯一性校验排除自身），旧哈希作废 |
| DELETE | `/api/admin/members/{id}`                                   | 删除成员；事务内自动作废其 pending 提交（reason=「目标成员已被删除，提交自动作废」）；重复删除返回 404                                                 |

### 主要错误码速查

| code                              | 含义                                         |
| --------------------------------- | -------------------------------------------- |
| `PARAM_MISSING`                   | 缺少参数或请求体不合法                       |
| `FIELD_MISSING`                   | 缺少必填字段                                 |
| `FIELD_INVALID`                   | 字段格式不正确（标签≤8 个、社交链接≤8 条等） |
| `FIELD_FORBIDDEN`                 | 字段不允许提交/修改                          |
| `NAME_NOT_FOUND`                  | 姓名不在登记名单                             |
| `NAME_MISMATCH`                   | 姓名不属于所指定的成员                       |
| `TOKEN_INVALID` / `TOKEN_EXPIRED` | verifyToken 无效或已过期                     |
| `PASSWORD_WRONG`                  | 管理密码错误                                 |
| `ADMIN_TOKEN_INVALID`             | 未登录或会话失效                             |
| `RATE_LIMITED`                    | 触发限流（HTTP 429）                         |
| `REALNAME_EXISTS`                 | 该真实姓名已登记给其他成员                   |
| `ALREADY_REVIEWED`                | 审核记录已处理（HTTP 409）                   |
| `MEMBER_NOT_FOUND`                | 成员不存在                                   |
| `REASON_REQUIRED`                 | 驳回缺少理由                                 |
| `BODY_TOO_LARGE`                  | 请求体超 64KB（HTTP 413）                    |

## 安全设计

### realName「只进不出」双哈希方案

| 哈希列                       | 算法                                   | 用途           |
| ---------------------------- | -------------------------------------- | -------------- |
| `real_name_lookup`（UNIQUE） | SHA-256(realName + PEPPER)，确定性     | 查重、等值查找 |
| `real_name_verify`           | PBKDF2-SHA256，10 万轮 + 16 字节随机盐 | 登录式验证比对 |

- 明文仅在本请求内存期间存在，验证完成即丢弃；
- 所有查询列显式挑选非敏感字段，两列哈希**永不输出**——即使管理员也无法反查任何人的真实姓名；
- 若需真正的 argon2id，可外接 Cloudflare Password Hashing 或 WASM 方案替代。

### 其他安全措施

- **令牌体系**：verify_tokens / admin_sessions 落 D1；verifyToken 在事务中随提交一次性消费；adminToken 支持吊销；过期令牌惰性清理；
- **恒时比较**：密码与慢哈希校验使用 timing-safe 比较，防时序侧信道；
- **限流**：D1 计数窗口实现，`verify-name` 5 次/分钟、`admin/login` 5 次/分钟、`submissions` 10 次/小时；
- **输入校验**：请求体 ≤ 64KB；字段白名单 + 类型校验；URL 仅允许 http/https（裸域名自动补 `https://`），其他协议（如 javascript:）一律拒绝；
- **越权防护**：verifyName 时如指定 memberId 且与姓名不匹配则拒绝（403），防止横向枚举；
- **删除级联原子性**：依赖 D1 `batch()` 的隐式事务，先作废 pending 再删行，杜绝悬空审核记录。

## 冒烟测试

```bash
BASE=https://<your-worker>.workers.dev
# 公开成员列表（应为 {"ok":true,"data":[]}）
curl $BASE/api/members
# 登录拿 token
TOK=$(curl -s $BASE/api/admin/login -X POST \
  -H 'Content-Type: application/json' \
  -d '{"password":"你的密码"}' | jq -r .data.adminToken)
# 添加成员（张三）
curl $BASE/api/admin/members -X POST \
  -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"realName":"张三","name":"御坂美琴","generation":"2025","role":"社长","bio":"超电磁炮","tags":["动漫"]}'
# 用户实名验证 → 提交修改 → 审核
VT=$(curl -s $BASE/api/verify-name -X POST \
  -H 'Content-Type: application/json' \
  -d '{"realName":"张三"}' | tee /dev/stderr | jq -r .data.verifyToken)
SID=$(curl -s $BASE/api/submissions -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"verifyToken\":\"$VT\",\"changes\":{\"bio\":\"新的简介\"}}" \
  | jq -r .data.submissionId)
curl "$BASE/api/admin/submissions?status=pending" -H "Authorization: Bearer $TOK"
curl -X POST "$BASE/api/admin/submissions/$SID/approve" \
  -H "Authorization: Bearer $TOK"
# 访问主页
open $BASE/
```

## 常见问题

**Q1：忘记管理密码怎么办？**
重新注入即可覆盖：`npx wrangler secret put ADMIN_PASSWORD`，随后已发出的 adminToken 不受影响，无需重启 Worker。
**Q2：可以更换 SERVER_PEPPER 吗？**
不建议。`SERVER_PEPPER` 参与 deterministic 哈希，更换后已存的 `real_name_lookup` 将全部失配，用户无法再验名。若必须更换，需要逐个成员用新姓名调用管理员更新接口重建哈希。
**Q3：为什么管理员也看不到成员的真实姓名？**
这是有意设计（§3.4）。登记 姓名 存哈希摘要不可逆，保证数据库泄露场景下会员隐私不受影响；管理员可通过「新增/更新成员」重置某条登记姓名。
**Q4：并发同时 approve 多个 pending 提交会怎样？**
系统采用 last-write-wins 策略全量应用，不做冲突检测；若成员在其间被删除，approve 返回 `404 MEMBER_NOT_FOUND` 拒绝应用。
**Q5：本地开发？**

创建`.dev.vars`，写入以下内容

```
SERVER_PEPPER=123456
ADMIN_PASSWORD=123456
```

然后

```bash
npx wrangler dev                # 本地起 Worker + 本地模拟 D1/Assets
npx wrangler d1 execute star-timeline --local --file=./schema.sql   # 本地初始化表
```

---

License · 只做热爱的事，让每一颗星星都有自己的轨迹 ✦
