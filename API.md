# 星轨社团成员时间线系统 · API 文档

| 项目         | 内容                                                                  |
| ------------ | --------------------------------------------------------------------- |
| **文档版本** | v1.0                                                                  |
| **更新日期** | 2026-08-27                                                            |
| **适用范围** | 前台成员时间线、用户自助修改资料、后台审核与成员管理                  |
| **约定基准** | 与前端实现（apiFetch 请求层）严格对齐，后端按本文档实现即可零改动对接 |

---

## 目录

- [1. 概述](#1-概述)
- [2. 通用约定](#2-通用约定)
- [3. 数据模型](#3-数据模型)
- [4. 接口详情](#4-接口详情)
- [5. 业务规则与副作用](#5-业务规则与副作用)
- [6. 安全规范](#6-安全规范)
- [7. 附录](#7-附录)

---

## 1. 概述

### 1.1 基本信息

| 项            | 约定                                       |
| ------------- | ------------------------------------------ |
| Base URL      | `/api`                                     |
| 传输协议      | 仅 HTTPS                                   |
| 请求/响应格式 | `application/json; charset=utf-8`          |
| 时间格式      | ISO 8601（UTC），如 `2026-08-27T06:00:00Z` |
| ID 类型       | 正整数，服务端自增分配                     |

### 1.2 角色与权限模型

| 角色                 | 鉴权方式                | 能力                                   |
| -------------------- | ----------------------- | -------------------------------------- |
| 游客（任何人）       | 无                      | 查看成员列表、验证姓名、提交修改审核   |
| 成员（通过姓名验证） | `verifyToken`（一次性） | 修改本人资料（须审核后生效）           |
| 管理员               | `adminToken`（Bearer）  | 审核、增删改成员（立即生效，不走审核） |

> 💡 没有注册/登录体系。成员身份通过「真实姓名哈希比对」临时确立；管理员通过固定密码登录。

### 1.3 核心业务流

**用户修改流程（需审核）：**

```
输入真实姓名 ──> POST /verify-name ──> verifyToken (5min / 一次性)
                                          │
                                          ▼
                              POST /submissions {verifyToken, changes}
                                          │
                                          ▼
                                   进入 pending 队列
                                          │
                        ┌─── 管理员 approve ───> changes 应用到 member
                        └─── 管理员 reject ───> 记录驳回理由
```

**管理员操作流程（立即生效）：**

```
POST /admin/login ──> adminToken ──> GET/POST/PUT/DELETE /admin/members
```

---

## 2. 通用约定

### 2.1 统一响应包

所有接口（包括错误）都返回 JSON 包装结构，`ok` 字段为总开关：

```jsonc
// 成功
{ "ok": true, "data": <业务数据，类型见各接口> }
// 失败
{
  "ok": false,
  "error": { "code": "NAME_NOT_FOUND", "message": "该姓名不在社团登记名单中" }
}
```

> 📌 客户端判定逻辑：HTTP 状态非 2xx **或** `payload.ok !== true` 均视为失败，以 `error.code` / `error.message` 为准。HTTP 状态码与 `error.code` 需同时正确。

### 2.2 认证方式

后台接口（路径以 `/admin/` 开头，`/admin/login` 除外）必须携带：

```
Authorization: Bearer <adminToken>
```

### 2.3 令牌体系

|              | verifyToken                                      | adminToken                                                    |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------- |
| **签发方**   | `POST /verify-name`                              | `POST /admin/login`                                           |
| **传递方式** | 请求 body                                        | `Authorization` 头                                            |
| **有效期**   | 5 分钟                                           | 2 小时（`expiresAt` 一并返回）                                |
| **使用次数** | 一次性：提交成功时销毁；校验失败不消耗；到期销毁 | 有效期内不限次                                                |
| **失效表现** | `TOKEN_INVALID` / `TOKEN_EXPIRED`                | `ADMIN_TOKEN_INVALID`（客户端收到后清除本地令牌并回到登录页） |

> 格式建议：加密随机不透明字符串（如 `vt_` + 32 位随机），不建议携带数据的 JWT；adminToken 需支持服务端吊销（会话表）。

### 2.4 HTTP 状态码

| 状态码 | 含义           | 本系统使用场景                      |
| ------ | -------------- | ----------------------------------- |
| 200    | 成功           | 所有成功响应                        |
| 400    | 客户端参数错误 | 校验失败（见错误码表）              |
| 401    | 认证失败       | 姓名不存在、令牌无效/过期、密码错误 |
| 403    | 授权失败       | 姓名与目标成员不匹配                |
| 404    | 资源不存在     | 审核/成员不存在、路由不存在         |
| 409    | 冲突           | 重复审核、姓名重复登记              |
| 429    | 限流           | 触发频率限制                        |
| 500    | 服务端异常     | `INTERNAL_ERROR`                    |

### 2.5 错误码总表

| code                  | HTTP | 触发场景                                      |
| --------------------- | ---- | --------------------------------------------- |
| `PARAM_MISSING`       | 400  | verify-name 未传 realName                     |
| `FIELD_MISSING`       | 400  | 添加成员缺 realName / name / generation       |
| `FIELD_INVALID`       | 400  | name / generation 字段存在但为空串            |
| `FIELD_FORBIDDEN`     | 400  | changes 中包含 realName（或任意白名单外字段） |
| `CHANGES_EMPTY`       | 400  | changes 为空对象                              |
| `REASON_REQUIRED`     | 400  | 驳回时未填 reason                             |
| `NAME_NOT_FOUND`      | 401  | 验证姓名未登记                                |
| `TOKEN_INVALID`       | 401  | verifyToken 不存在或已使用                    |
| `TOKEN_EXPIRED`       | 401  | verifyToken 已过期                            |
| `PASSWORD_WRONG`      | 401  | 管理密码错误                                  |
| `ADMIN_TOKEN_INVALID` | 401  | adminToken 缺失/无效/过期                     |
| `NAME_MISMATCH`       | 403  | 姓名存在但与指定 memberId 不匹配              |
| `NOT_FOUND`           | 404  | 审核记录不存在 / 未知路由                     |
| `MEMBER_NOT_FOUND`    | 404  | 成员不存在（含：审核通过时目标成员已被删除）  |
| `REALNAME_EXISTS`     | 409  | 真实姓名已登记给其他成员                      |
| `ALREADY_REVIEWED`    | 409  | 审核记录已处理（终态）                        |
| `RATE_LIMITED`        | 429  | 触发限流                                      |
| `INTERNAL_ERROR`      | 500  | 服务端异常（兜底）                            |

---

## 3. 数据模型

### 3.1 Member（对外对象）

所有返回成员的接口统一使用此结构：

```json
{
  "id": 1,
  "name": "御坂美琴",
  "generation": "2025",
  "role": "社长 · 电击使",
  "bio": "常盘台中学王牌，超电磁炮使用者。",
  "tags": ["动漫", "游戏", "cosplay", "音乐"],
  "social": [{ "name": "哔哩哔哩", "url": "https://bilibili.com/misaka" }],
  "avatar": "https://api.dicebear.com/7.x/thumbs/svg?seed=Misaka"
}
```

### 3.2 字段定义与校验规则

| 字段         |      类型      |  创建必填  |     用户提交流可改     |         管理端可改          | 约束                                            |
| ------------ | :------------: | :--------: | :--------------------: | :-------------------------: | ----------------------------------------------- |
| `id`         |     number     | 服务端生成 |           ✗            |              ✗              | 正整数，自增                                    |
| `realName`   |     string     |     ✓      | ✗（`FIELD_FORBIDDEN`） |  ✓（PUT 时缺省/空 = 不变）  | 全局唯一；仅存哈希，任何响应不含此字段          |
| `name`       |     string     |     ✓      |           ✓            |     ✓（出现则必须非空）     | 非空，建议 ≤ 32 字符                            |
| `generation` |     string     |     ✓      |           ✓            |     ✓（出现则必须非空）     | 非空，如 `"2025"`                               |
| `role`       |     string     |     ✗      |           ✓            | ✓（出现即覆盖，可空串清空） | 建议 ≤ 32 字符                                  |
| `bio`        |     string     |     ✗      |           ✓            |          ✓（同上）          | 建议 ≤ 500 字符                                 |
| `avatar`     |     string     |     ✗      |           ✓            |          ✓（同上）          | URL 或空；空 = 前端用昵称首字占位               |
| `tags`       |    string[]    |     ✗      |           ✓            |     ✓（出现则整体替换）     | 建议每项 ≤ 12 字符、总数 ≤ 8                    |
| `social`     | `{name,url}[]` |     ✗      |           ✓            |     ✓（出现则整体替换）     | 建议每项两字段非空、总数 ≤ 8；URL 须 http/https |

**部分更新语义（PUT /admin/members/{id}）：**

- 字段未出现在 JSON 中 = 不修改；出现即修改
- `tags` / `social` 无「追加」语义，传则整体替换
- `realName` 特殊：出现但为空串 = 忽略（该字段无清除语义）
  **URL 规范化：** 客户端展示时对无协议前缀的 URL 自动补 `https://`；服务端存储时应校验并规范化。

### 3.3 Submission（审核记录）

```json
{
  "id": 12,
  "verifiedByRealName": true,
  "memberId": 1,
  "memberName": "御坂美琴",
  "changes": { "bio": "新的简介内容" },
  "oldData": { "bio": "旧的简介内容" },
  "createdAt": "2026-08-27T06:00:00Z",
  "status": "pending",
  "reason": null,
  "reviewedAt": null
}
```

| 字段                      | 类型            | 说明                                                                     |
| ------------------------- | --------------- | ------------------------------------------------------------------------ |
| `id`                      | number          | 提交记录 ID                                                              |
| `verifiedByRealName`      | boolean         | 恒为 `true`。提交时已通过实名验证的标记。不含任何明文/哈希姓名（见 3.4） |
| `memberId` / `memberName` | number / string | 提交时刻的目标成员（快照）                                               |
| `changes`                 | object          | 变更字段集，仅含白名单字段                                               |
| `oldData`                 | object          | 提交时刻的字段快照，仅含 changes 中出现的字段，供审核界面展示 diff       |
| `createdAt`               | string          | 提交时间                                                                 |
| `status`                  | string          | `pending` / `approved` / `rejected`                                      |
| `reason`                  | string \| null  | 驳回理由（仅 rejected）                                                  |
| `reviewedAt`              | string \| null  | 处理时间（仅终态）                                                       |

### 3.4 realName「只进不出」原则（核心安全约定）

realName 是**只写**字段，全系统唯一入口是管理端成员管理：

- **只进**
  - `POST /admin/members`（必填）
  - `PUT /admin/members/{id}`（非空时覆盖）
- **不出的范围：**
  - `GET /members`、`GET /admin/members`、`/verify-name` 返回的 member —— 均不含该字段（**管理员也拿不到**）
  - 审核记录不含提交人姓名，仅 `verifiedByRealName: true` 标记
  - 任何错误信息、日志、缓存中均不得出现明文
- **用户提交流禁止修改该字段：** `changes.realName` → `400 FIELD_FORBIDDEN`
- **生产存储：** 仅存哈希（方案见 §6.1），明文只在单个请求的内存处理期间存在
- **唯一性：** 同一真实姓名只能登记给一个成员（`REALNAME_EXISTS`）
- **销毁：** 删除成员时，其姓名哈希随之删除

---

## 4. 接口详情

### 4.1 GET /api/members — 成员列表

获取全部已生效成员。前台时间线数据源。

- **权限：** 公开
- **请求参数：** 无
  **成功 200：**

```json
{ "ok": true, "data": [{ "...Member 对象": "" }] }
```

**说明：**

- 数组顺序不做保证，客户端按 generation 分组、降序展示
- 管理员添加成员、审核通过的修改，立即反映在此接口
- 空列表返回 `"data": []`（非 null）
  **错误：** 仅通用 `500 INTERNAL_ERROR`

---

### 4.2 POST /api/verify-name — 真实姓名验证

验证真实姓名，签发一次性 verifyToken，并返回对应成员当前资料（供表单预填）。

- **权限：** 公开（强制限流，见 §6.3）
  **请求 Body：**
  | 字段 | 类型 | 必填 | 说明 |
  |---|---|:---:|---|
  | `realName` | string | ✓ | 真实姓名明文；仅在本请求处理期间存在于内存 |
  | `memberId` | number | ✗ | 从指定成员卡发起修改时传入，用于校验「该姓名确实属于该成员」，防横向越权 |

```json
{ "realName": "张三", "memberId": 3 }
```

**成功 200：**

```json
{
  "ok": true,
  "data": {
    "memberId": 3,
    "verifyToken": "vt_a1b2c3d4e5f6...",
    "member": { "...Member 对象（不含 realName）": "" }
  }
}
```

**错误：**
| code | 条件 |
|---|---|
| `PARAM_MISSING` | realName 为空 |
| `NAME_NOT_FOUND` | 姓名不在登记名单 |
| `NAME_MISMATCH` | 姓名存在，但与传入的 memberId 不属于同一成员 |
| `RATE_LIMITED` | 触发限流 |
**说明：**

- 服务端对输入做哈希后与存储哈希比对（§6.1），明文不落库
- memberId 匹配校验优先于其他业务（找到成员后立即比对）

---

### 4.3 POST /api/submissions — 提交资料修改

将修改提交至审核队列。

- **权限：** 公开（需有效 verifyToken）
  **请求 Body：**
  | 字段 | 类型 | 必填 | 说明 |
  |---|---|:---:|---|
  | `verifyToken` | string | ✓ | 4.2 签发的一次性令牌 |
  | `changes` | object | ✓ | 变更字段集，仅包含发生变化的字段 |

```json
{
  "verifyToken": "vt_a1b2c3d4e5f6...",
  "changes": {
    "bio": "新的简介",
    "tags": ["动漫", "音乐"],
    "social": [{ "name": "哔哩哔哩", "url": "https://bilibili.com/xxx" }]
  }
}
```

> ⚠️ **changes 字段白名单：** `name`、`generation`、`role`、`bio`、`avatar`、`tags`、`social`。其余任何字段（含 realName、id）→ `400 FIELD_FORBIDDEN`。
> **成功 200：**

```json
{ "ok": true, "data": { "submissionId": 12 } }
```

**错误：**
| code | 条件 |
|---|---|
| `TOKEN_INVALID` | 令牌不存在或已使用 |
| `TOKEN_EXPIRED` | 令牌已过期 |
| `CHANGES_EMPTY` | changes 为空对象或非法类型 |
| `FIELD_INVALID` | name / generation 为空串 |
| `FIELD_FORBIDDEN` | 含白名单外字段 |
| `RATE_LIMITED` | 限流 |
**说明：**

- 令牌在提交成功时销毁；校验类失败（CHANGES_EMPTY 等）**不消耗令牌**，用户修正后可直接重提
- 服务端在提交时记录 oldData 快照
- 前端已做 diff 只发变化字段，服务端仍须独立校验字段类型与约束

---

### 4.4 POST /api/admin/login — 后台登录

- **权限：** 公开（强制限流）
  **请求 Body：**

```json
{ "password": "..." }
```

**成功 200：**

```json
{
  "ok": true,
  "data": {
    "adminToken": "at_x9y8z7...",
    "expiresAt": "2026-08-27T08:00:00Z"
  }
}
```

## **错误：** `401 PASSWORD_WRONG` / `429 RATE_LIMITED`

### 4.5 GET /api/admin/submissions — 审核记录列表

- **权限：** 管理员
  **Query 参数：**
  | 参数 | 可选值 | 默认 | 说明 |
  |---|---|---|---|
  | `status` | `pending` / `approved` / `rejected` | `pending` | 按状态筛选 |
  **成功 200：**

```json
{ "ok": true, "data": [{ "...Submission 对象": "" }] }
```

- **排序：** `createdAt` 降序（最新在前）
- 非法 status 值返回空数组或 400（二选一，需后端固定行为）
  **错误：** `401 ADMIN_TOKEN_INVALID`

---

### 4.6 POST /api/admin/submissions/{id}/approve — 通过审核

- **权限：** 管理员
- **Body：** 无
  **成功 200：**

```json
{ "ok": true, "data": { "applied": true } }
```

**副作用：**

- 将 changes 应用到对应成员（last-write-wins，不做冲突检测）
- status → `approved`，reviewedAt 记录当前时间
  **错误：**
  | code | 条件 |
  |---|---|
  | `ADMIN_TOKEN_INVALID` | 未认证 |
  | `NOT_FOUND` | 审核记录不存在 |
  | `ALREADY_REVIEWED` | 已处理（终态） |
  | `MEMBER_NOT_FOUND` | 目标成员已被删除，拒绝应用 |

---

### 4.7 POST /api/admin/submissions/{id}/reject — 驳回

- **权限：** 管理员
  **请求 Body：**
  | 字段 | 类型 | 必填 | 说明 |
  |---|---|:---:|---|
  | `reason` | string | ✓ | 驳回理由，非空 |

```json
{ "reason": "简介内容不合适，请修改后重新提交" }
```

**成功 200：**

```json
{ "ok": true, "data": { "applied": false } }
```

**副作用：** status → `rejected`，记录 reason 与 reviewedAt。**不触碰成员数据。**
**错误：** `401 ADMIN_TOKEN_INVALID` / `404 NOT_FOUND` / `409 ALREADY_REVIEWED` / `400 REASON_REQUIRED`

---

### 4.8 GET /api/admin/members — 成员列表（管理端）

- **权限：** 管理员
  **成功 200：**

```json
{ "ok": true, "data": [{ "...Member 对象（不含 realName）": "" }] }
```

> 🔒 即使是管理员，也无法获取任何成员的真实姓名（含哈希）——只进不出原则对管理端同样生效（§3.4）。

## **错误：** `401 ADMIN_TOKEN_INVALID`

### 4.9 POST /api/admin/members — 添加成员

- **权限：** 管理员
- **生效方式：** 立即生效，不进入审核流
  **请求 Body：**

```json
{
  "realName": "张三",
  "name": "新成员",
  "generation": "2026",
  "role": "活动执行",
  "bio": "……",
  "avatar": "",
  "tags": ["动漫"],
  "social": [{ "name": "哔哩哔哩", "url": "https://…" }]
}
```

| 字段                      | 必填 | 说明                                           |
| ------------------------- | :--: | ---------------------------------------------- |
| `realName`                |  ✓   | 明文，服务端立即哈希后存储，明文不落库不写日志 |
| `name`                    |  ✓   | 非空                                           |
| `generation`              |  ✓   | 非空                                           |
| `role` / `bio` / `avatar` |  ✗   | 可为空串                                       |
| `tags` / `social`         |  ✗   | 缺省为 `[]`                                    |

> 校验顺序建议：realName 非空 → realName 唯一 → name 非空 → generation 非空 → 其余字段类型校验。
> **成功 200：**

```json
{ "ok": true, "data": { "id": 13 } }
```

## **错误：** `401 ADMIN_TOKEN_INVALID` / `400 FIELD_MISSING` / `409 REALNAME_EXISTS`

### 4.9b POST /api/admin/members/batch — 批量导入成员

- **权限：** 管理员
- **生效方式：** 立即生效，不进入审核流
- **说明：** 与 §4.9 同款校验（realName 必填 + 唯一；name/generation 必填；其余字段类型校验）。单批最多 200 条；批内重复 realName 标记 `DUPLICATE_IN_BATCH`，与已有成员重复标记 `REALNAME_EXISTS`，字段非法进入 `errors`。成功项通过 `env.DB.batch()` 原子插入。
  **请求 Body：**

```json
{
  "members": [
    { "realName": "张三", "name": "御坂美琴", "generation": "2025", "role": "", "bio": "", "avatar": "", "tags": ["动漫"], "social": [] },
    { "realName": "李四", "name": "立华奏", "generation": "2025" }
  ]
}
```

> 成功 200：

```json
{
  "ok": true,
  "data": {
    "created": [{ "index": 1, "id": 13, "name": "御坂美琴" }],
    "skipped": [{ "index": 2, "realName": "李四", "reason": "REALNAME_EXISTS" }],
    "errors": [],
    "total": 2
  }
}
```

## **错误：** `401 ADMIN_TOKEN_INVALID` / `400 FIELD_MISSING`（members 为空）/ `400 FIELD_INVALID`（超过 200 条）

### 4.10 PUT /api/admin/members/{id} — 编辑成员

- **权限：** 管理员
- **生效方式：** 立即生效
- **语义：** 部分更新，字段缺省 = 不修改（规则见 §3.2）
  **请求 Body（全部可选）：**

```json
{
  "realName": "",
  "name": "新昵称",
  "generation": "2025",
  "role": "新职位",
  "bio": "新简介",
  "avatar": "https://…",
  "tags": ["动漫", "音乐"],
  "social": [{ "name": "GitHub", "url": "https://github.com/xxx" }]
}
```

| 字段                      | 语义                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `realName`                | 缺省或空串 = 保持不变（该字段无「清除」语义）；**非空 = 覆盖登记**（旧哈希作废，成员此后须用新姓名验证），覆盖前须做唯一性校验（排除自身） |
| `name` / `generation`     | 出现则必须非空，否则 `FIELD_INVALID`                                                                                                       |
| `role` / `bio` / `avatar` | 出现即覆盖，传空串可清空                                                                                                                   |
| `tags` / `social`         | 出现即整体替换                                                                                                                             |

**成功 200：**

```json
{ "ok": true, "data": { "updated": true } }
```

## **错误：** `401 ADMIN_TOKEN_INVALID` / `404 MEMBER_NOT_FOUND` / `400 FIELD_INVALID` / `409 REALNAME_EXISTS`

### 4.11 DELETE /api/admin/members/{id} — 删除成员

- **权限：** 管理员
- **Body：** 无
  **成功 200：**

```json
{ "ok": true, "data": { "deleted": true } }
```

**级联副作用（原子事务）：**

1. 删除成员记录（含其姓名哈希——该姓名随之释放，可被未来新成员登记）
2. 该成员所有 pending 提交自动作废：status → `rejected`、reason = `"目标成员已被删除，提交自动作废"`、记录 reviewedAt
   **错误：** `401 ADMIN_TOKEN_INVALID` / `404 MEMBER_NOT_FOUND`
   > ⚠️ 非幂等：重复删除同一 id 返回 404（前端已做两步确认与按钮禁用防重）。

---

## 5. 业务规则与副作用

### 5.1 审核状态机

```
                ┌── approve（管理员）──────────> approved（终态，changes 已应用）
  pending ──────┤
                ├── reject（管理员，必填理由）──> rejected（终态）
                └── 目标成员被删除（自动）─────> rejected（理由固定）
```

- `approved` / `rejected` 为终态，再次操作返回 `409 ALREADY_REVIEWED`
- 无撤回、无重新打开操作

### 5.2 并发与一致性规则

| 场景                                   | 行为                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 同一成员存在多个 pending 提交          | 允许；按审核先后逐个应用，后审先的覆盖先审先的（last-write-wins）                                               |
| 提交后、审核前，管理员已直接编辑该成员 | approve 时 changes 仍全量应用（覆盖管理员的中间修改）；oldData 是提交时刻快照，可能与审核时刻的「当前值」不一致 |
| 审核通过时成员已被删除                 | 拒绝应用，返回 `404 MEMBER_NOT_FOUND`                                                                           |
| 删除成员与审核并发                     | 删除事务级联作废 pending；已终态的记录不受影响                                                                  |

### 5.3 数据可见性汇总

| 数据                        |         游客         |        管理员        |
| --------------------------- | :------------------: | :------------------: |
| 成员公开字段                |          ✓           |          ✓           |
| 成员 realName（明文或哈希） |          ✗           | ✗（任何接口不返回）  |
| 提交人身份                  | 仅「已实名验证」标记 | 仅「已实名验证」标记 |
| 驳回理由                    |          —           |          ✓           |
| 待审/已审记录               |          ✗           |          ✓           |

---

## 6. 安全规范

### 6.1 realName 双哈希存储方案（生产环境必读）

**难点：** 真实姓名熵值极低（中文姓名空间可被字典枚举），且业务需要「查重」与「查找」。单一哈希方案无法兼顾，推荐双列：

```
real_name_lookup = SHA-256( realName + SERVER_PEPPER )   ← 确定性哈希
real_name_verify = argon2id( realName )                  ← 慢哈希
```

| 列                 | 用途                                                         | 依赖特性               |
| ------------------ | ------------------------------------------------------------ | ---------------------- |
| `real_name_lookup` | 建唯一索引 → 查重（REALNAME_EXISTS）；verify-name 的等值查找 | 确定性（同输入同输出） |
| `real_name_verify` | 验证时做慢哈希比对                                           | 抗离线爆破             |

**方案取舍：**

- ❌ 只用 bcrypt —— 随机盐导致无法确定性查找与查重
- ❌ 只用 SHA-256 + pepper —— 库泄露 + pepper 泄露时可被字典爆破；慢哈希列显著抬高成本
- 🔑 PEPPER 存放于环境变量 / KMS，**绝不入库、不入备份、不写日志、不进代码库**
  > 降级方案（可接受更高风险时）：单列 `HMAC-SHA256(PEPPER, realName)` + 严格限流（§6.3）

### 6.2 明文处理红线

realName 明文仅允许存在于**单个请求的处理内存中**，以下位置严禁出现：

- ❌ **任何日志** —— 包括访问日志的 request body（需配置 body 脱敏或关闭 body 记录）、应用日志、错误堆栈
- ❌ **任何缓存**（Redis / CDN / 本地缓存）
- ❌ **任何 API 响应** —— 含管理端、调试端点、错误信息、message 字段
- ❌ **任何持久化** —— 数据库、消息队列、审计日志、备份

### 6.3 限流策略（强制）

| 接口                | 限制（建议）     | 原因                                                 |
| ------------------- | ---------------- | ---------------------------------------------------- |
| `POST /verify-name` | **5 次/分钟/IP** | 最高优先级——哈希无法防御在线枚举，短姓名空间易被穷举 |
| `POST /admin/login` | 5 次/分钟/IP     | 防密码爆破                                           |
| `POST /submissions` | 10 次/小时/IP    | 防审核队列被灌水                                     |
| 其余接口            | 60 次/分钟/IP    | 常规保护                                             |

超限统一返回 `429 RATE_LIMITED`。

### 6.4 其他安全要求

| 项         | 要求                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 传输       | 全站 HTTPS（建议 + HSTS）                                                                        |
| 管理密码   | bcrypt / argon2id 存储（cost ≥ 10），环境变量注入，不进代码库                                    |
| 服务端校验 | 所有输入独立校验（前端校验仅为体验）：类型、长度上限、URL 协议白名单（http/https）、标签数量上限 |
| Body 限制  | 请求体大小上限（如 64KB）                                                                        |
| adminToken | 服务端维护会话表，支持主动吊销；客户端存 sessionStorage                                          |
| CORS       | 按部署域名白名单配置                                                                             |
| 建议扩展   | 管理员操作审计日志（不含 realName）、删除等破坏性操作的二次认证                                  |

---

## 7. 附录

### 7.1 接口速查表

|  #  | 方法   | 路径                            | 权限        | 说明                         |
| :-: | ------ | ------------------------------- | ----------- | ---------------------------- |
|  1  | GET    | `/api/members`                  | 公开        | 成员列表（前台数据源）       |
|  2  | POST   | `/api/verify-name`              | 公开 + 限流 | 姓名验证，签发 verifyToken   |
|  3  | POST   | `/api/submissions`              | verifyToken | 提交修改（进审核队列）       |
|  4  | POST   | `/api/admin/login`              | 公开 + 限流 | 后台登录                     |
|  5  | GET    | `/api/submissions?status=`      | adminToken  | 审核记录列表                 |
|  6  | POST   | `/api/submissions/{id}/approve` | adminToken  | 通过（应用变更）             |
|  7  | POST   | `/api/submissions/{id}/reject`  | adminToken  | 驳回（必填理由）             |
|  8  | GET    | `/api/admin/members`            | adminToken  | 成员列表（管理端）           |
|  9  | POST   | `/api/admin/members`            | adminToken  | 添加成员（立即生效）         |
| 10  | PUT    | `/api/admin/members/{id}`       | adminToken  | 编辑成员（立即生效）         |
| 11  | DELETE | `/api/admin/members/{id}`       | adminToken  | 删除成员（级联作废 pending） |

### 7.2 客户端行为约定（后端需知悉）

- 收到 `401 ADMIN_TOKEN_INVALID` → 客户端清除令牌、回到后台登录页
- verify-name 失败时，客户端原样展示 `error.message`（因此 message 需用户友好）
- 任何管理端成员变更后，客户端会在下次进入前台时重新拉取 `/members`

### 7.3 Mock 演示环境

前端内置 Mock（`USE_MOCK = true`），无需后端即可演示全流程：

- **后台密码：** `admin888`
- **测试真实姓名 ↔ 成员：**
  | 真实姓名 | 昵称 | 真实姓名 | 昵称 |
  |---|---|---|---|
  | 张三 | 御坂美琴 | 周八 | 比企谷八幡 |
  | 李四 | 立华奏 | 吴九 | 时崎狂三 |
  | 王五 | 椎名真白 | 郑十 | 五河士道 |
  | 赵六 | 夏目贵志 | 陈一 | 亚丝娜 |
  | 孙七 | 雪之下雪乃 | 林二 | 桐人 |
  | 黄三 | 初音未来 | 徐四 | 洛天依 |
- Mock 内存中保存明文仅用于模拟哈希比对，对外输出全部剔除，行为与本文档一致
- 接真实后端：将前端 `USE_MOCK` 改为 `false`，按本文档实现 11 个接口即可，前端零改动

### 7.4 版本演进建议（v2 方向，本期不实现）

- [ ] 列表分页：`?page=&pageSize=` → `data: { list, total }`
- [ ] 按成员查询其提交历史
- [ ] 审核记录与成员版本号乐观锁（替代 last-write-wins）
- [ ] verifyToken 绑定来源 IP / 设备指纹
- [ ] 管理员多账号与操作审计

---

> 📄 文档结束。任何接口行为与本文档冲突时，以本文档为准；如需变更，须同步更新前端 apiFetch 调用侧与错误码处理逻辑。
