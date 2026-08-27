/**
 * 星轨社团成员时间线系统 · 后端实现
 * Cloudflare Workers + D1。任何行为冲突以《API 文档》为准。
 */

/* =============== 常量（对应文档约定） =============== */
const WHITELIST_FIELDS = [
  "name",
  "generation",
  "role",
  "bio",
  "avatar",
  "tags",
  "social",
]; // §4.3 白名单
const VERIFY_TTL_MS = 5 * 60 * 1000; // verifyToken 有效期 5 分钟（§2.3）
const SESSION_TTL_MS = 2 * 3600 * 1000; // adminToken 有效期 2 小时（§2.3）
const MAX_BODY_BYTES = 64 * 1024; // 请求体上限 64KB（§6.4）

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ENCODER = new TextEncoder();

/* =============== 统一响应包（§2.1） =============== */
class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
const OK = (data) => jsonRes({ ok: true, data }, 200);
const ERR = (code, message, status) =>
  jsonRes({ ok: false, error: { code, message } }, status);
const nowISO = () => new Date().toISOString();

/* =============== 加密工具（§6.1 双列存储） =============== */

/** 确定性哈希：SHA-256(realName + SERVER_PEPPER)，建唯一索引做查重/查找 */
async function sha256Lookup(env, realName) {
  const pepper = env.SERVER_PEPPER || ""; // 生产环境必须通过 wrangler secret put 配置
  const buf = await crypto.subtle.digest(
    "SHA-256",
    ENCODER.encode(realName + pepper),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 慢哈希替代 argon2id：PBKDF2-SHA256（Web Crypto 内置可用）。格式：pbkdf2$轮数$盐$摘要 */
async function pbkdf2Hash(realName, iterations = 100000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(realName, salt, iterations);
  const hex = toHex(bits),
    saltHex = toHex(salt);
  return `pbkdf2$${iterations}$${saltHex}$${hex}`;
}
async function pbkdf2Verify(realName, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [, iterStr, saltHex, expected] = parts;
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await deriveBits(
    realName,
    salt,
    parseInt(iterStr, 10) || 100000,
  );
  return timingSafeEqual(toHex(bits), expected); // 恒时比较
}
async function deriveBits(str, saltBuf, iterations) {
  const km = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(str),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuf, iterations, hash: "SHA-256" },
    km,
    256,
  );
}
function toHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function randomToken(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return prefix + toHex(bytes);
}

/* =============== 校验工具 =============== */

function isHttpUrl(u) {
  try {
    return /^https?:$/i.test(new URL(u).protocol);
  } catch {
    return false;
  }
}
/** 服务端 URL 规范化（§3.2）：补全无协议前缀的链接为 https:// */
function normUrl(u) {
  const t = String(u || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("//")) return "https:" + t;
  return "https://" + t;
}
/** 链接合法性：显式 http/https，或可规范化补 https 的裸域名；其他协议非法 */
function validUrlField(u) {
  if (!u) return true;
  return isHttpUrl(u) || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(String(u).trim());
}

/** 字段值校验（提交与管理端共用）；违规抛 ApiError */
function validateFieldValues(o) {
  if ("name" in o && (typeof o.name !== "string" || o.name.trim() === ""))
    throw new ApiError("FIELD_INVALID", "昵称不能为空", 400);
  if (
    "generation" in o &&
    (typeof o.generation !== "string" || o.generation.trim() === "")
  )
    throw new ApiError("FIELD_INVALID", "届别不能为空", 400);
  for (const k of ["role", "bio", "avatar"]) {
    if (k in o && typeof o[k] !== "string")
      throw new ApiError("FIELD_INVALID", `"${k}" 字段格式不正确`, 400);
  }
  if (o.avatar && !validUrlField(o.avatar))
    throw new ApiError("FIELD_INVALID", "头像链接格式不正确", 400);
  if ("tags" in o) {
    if (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== "string"))
      throw new ApiError("FIELD_INVALID", "标签格式不正确", 400);
    if (o.tags.length > 8)
      throw new ApiError("FIELD_INVALID", "标签最多 8 个", 400);
  }
  if ("social" in o) {
    if (!Array.isArray(o.social))
      throw new ApiError("FIELD_INVALID", "社交链接格式不正确", 400);
    for (const s of o.social) {
      if (
        !s ||
        typeof s !== "object" ||
        !String(s.name || "").trim() ||
        !String(s.url || "").trim()
      )
        throw new ApiError(
          "FIELD_INVALID",
          "社交链接的名称与网址均不能为空",
          400,
        );
      if (!validUrlField(s.url))
        throw new ApiError(
          "FIELD_INVALID",
          "社交链接必须使用 http/https 协议",
          400,
        );
    }
    if (o.social.length > 8)
      throw new ApiError("FIELD_INVALID", "社交链接最多 8 条", 400);
  }
}
/** 用户提交流 changes 校验（§4.3）：先白名单再类型，失败不消耗令牌 */
function validateChanges(changes) {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes))
    throw new ApiError("CHANGES_EMPTY", "提交内容格式不正确", 400);
  const keys = Object.keys(changes);
  if (keys.length === 0)
    throw new ApiError("CHANGES_EMPTY", "没有检测到修改内容", 400);
  for (const k of keys) {
    if (!WHITELIST_FIELDS.includes(k))
      throw new ApiError("FIELD_FORBIDDEN", `字段 "${k}" 不允许提交修改`, 400);
  }
  validateFieldValues(changes);
}
/** social 数组写库前统一规范化 URL */
function normalizeSocial(list) {
  return (Array.isArray(list) ? list : []).map((s) => ({
    name: String(s?.name || "").trim(),
    url: normUrl(s?.url),
  }));
}

/* =============== 行 <-> 对象序列化（输出一律不含 realName 相关字段） =============== */
function memberRowToObj(r) {
  return {
    id: r.id,
    name: r.name,
    generation: r.generation,
    role: r.role || "",
    bio: r.bio || "",
    tags: JSON.parse(r.tags || "[]"),
    social: JSON.parse(r.social || "[]"),
    avatar: r.avatar || "",
  };
}
function submissionRowToObj(r) {
  return {
    id: r.id,
    verifiedByRealName: !!r.verified_by_real_name,
    memberId: r.member_id,
    memberName: r.member_name,
    changes: JSON.parse(r.changes || "{}"),
    oldData: JSON.parse(r.old_data || "{}"),
    createdAt: r.created_at,
    status: r.status,
    reason: r.reason ?? null,
    reviewedAt: r.reviewed_at ?? null,
  };
}

/* =============== 基础设施 =============== */

async function readJson(request) {
  let text = "";
  try {
    text = await request.text();
  } catch {
    throw new ApiError("PARAM_MISSING", "无法读取请求体", 400);
  }
  if (ENCODER.encode(text).length > MAX_BODY_BYTES)
    throw new ApiError("BODY_TOO_LARGE", "请求体超过 64KB 上限", 413);
  if (!text.trim()) return {};
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new ApiError("PARAM_MISSING", "请求体不是合法 JSON", 400);
  }
  if (typeof j !== "object" || j === null || Array.isArray(j))
    throw new ApiError("PARAM_MISSING", "请求体应为 JSON 对象", 400);
  return j;
}

async function assertRateLimit(env, ip, endpoint, max, windowMs) {
  // §6.3
  const now = Date.now();
  await env.DB.prepare("DELETE FROM rate_limits WHERE endpoint=? AND ts<?")
    .bind(endpoint, now - windowMs)
    .run();
  const c = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM rate_limits WHERE ip=? AND endpoint=? AND ts>=?",
  )
    .bind(ip, endpoint, now - windowMs)
    .first();
  if (c.c >= max)
    throw new ApiError("RATE_LIMITED", "操作过于频繁，请稍后再试", 429);
  await env.DB.prepare("INSERT INTO rate_limits(ip,endpoint,ts) VALUES(?,?,?)")
    .bind(ip, endpoint, now)
    .run();
}

/** 惰性清理过期令牌与会话 */
async function cleanExpired(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM verify_tokens WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").bind(now),
  ]);
}

/** 管理员鉴权中间件（§2.2 / §2.3）：Bearer adminToken，查会话表，可吊销 */
async function requireAdmin(env, request) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  const token = m ? m[1].trim() : "";
  if (!token)
    throw new ApiError(
      "ADMIN_TOKEN_INVALID",
      "未登录或登录已失效，请重新登录",
      401,
    );
  await cleanExpired(env);
  const row = await env.DB.prepare(
    "SELECT token FROM admin_sessions WHERE token=? AND expires_at>?",
  )
    .bind(token, Date.now())
    .first();
  if (!row)
    throw new ApiError(
      "ADMIN_TOKEN_INVALID",
      "未登录或登录已失效，请重新登录",
      401,
    );
  return token;
}

/* =============== 接口实现（对应文档 §4.x 编号注释） =============== */

/* 4.1 GET /api/members */
async function listMembers(env) {
  const { results } = await env.DB.prepare(
    "SELECT id,name,generation,role,bio,tags,social,avatar FROM members ORDER BY id",
  ).all();
  return OK(results.map(memberRowToObj)); // 空列表返回 [] 而非 null
}

/* 4.2 POST /api/verify-name */
async function verifyName(env, request, ip) {
  await assertRateLimit(env, ip, "verify-name", 5, 60_000); // 强制限流 5次/分钟/IP
  const body = await readJson(request);
  const realName =
    typeof body.realName === "string" ? body.realName.trim() : "";
  if (!realName) throw new ApiError("PARAM_MISSING", "请输入真实姓名", 400);
  const wantedId = body.memberId == null ? null : Number(body.memberId);

  // 明文只在本请求内存期间存在；双哈希校验（§6.1）
  const lookup = await sha256Lookup(env, realName);
  const row = await env.DB.prepare(
    "SELECT * FROM members WHERE real_name_lookup=?",
  )
    .bind(lookup)
    .first();
  if (!row)
    throw new ApiError("NAME_NOT_FOUND", "该姓名不在社团登记名单中", 401);
  if (wantedId != null && row.id !== wantedId)
    // memberId 匹配优先（防横向越权）
    throw new ApiError("NAME_MISMATCH", "该姓名不属于所指定的成员", 403);
  if (!(await pbkdf2Verify(realName, row.real_name_verify)))
    throw new ApiError("NAME_NOT_FOUND", "该姓名不在社团登记名单中", 401);

  const token = randomToken("vt_");
  await env.DB.prepare(
    "INSERT INTO verify_tokens(token,member_id,expires_at) VALUES(?,?,?)",
  )
    .bind(token, row.id, Date.now() + VERIFY_TTL_MS)
    .run();

  return OK({
    memberId: row.id,
    verifyToken: token,
    member: memberRowToObj(row),
  });
}

/* 4.3 POST /api/submissions */
async function createSubmission(env, request, ip) {
  await assertRateLimit(env, ip, "submissions", 10, 3600_000); // 10次/小时/IP
  const body = await readJson(request);
  const vToken = typeof body.verifyToken === "string" ? body.verifyToken : "";

  // 先做校验类检查：此阶段失败不消耗令牌（§4.3 说明）
  validateChanges(body.changes);
  if (!vToken)
    throw new ApiError(
      "TOKEN_INVALID",
      "身份凭证无效，请重新进行姓名验证",
      401,
    );

  await cleanExpired(env);
  const trow = await env.DB.prepare("SELECT * FROM verify_tokens WHERE token=?")
    .bind(vToken)
    .first();
  if (!trow)
    throw new ApiError(
      "TOKEN_INVALID",
      "身份凭证无效，请重新进行姓名验证",
      401,
    );
  if (trow.expires_at <= Date.now())
    throw new ApiError(
      "TOKEN_EXPIRED",
      "身份凭证已过期，请重新进行姓名验证",
      401,
    );

  const mrow = await env.DB.prepare("SELECT * FROM members WHERE id=?")
    .bind(trow.member_id)
    .first();
  if (!mrow) throw new ApiError("MEMBER_NOT_FOUND", "目标成员不存在", 404);

  const cur = memberRowToObj(mrow);
  const changes = body.changes;
  const oldData = {}; // 提交时刻快照，仅含出现字段
  for (const k of Object.keys(changes)) oldData[k] = cur[k];

  // 服务端独立规范化 URL 后入库
  const chgStore = { ...changes };
  if ("avatar" in chgStore) chgStore.avatar = normUrl(chgStore.avatar);
  if ("social" in chgStore) chgStore.social = normalizeSocial(chgStore.social);
  const oldStore = { ...oldData };
  if ("avatar" in oldStore) oldStore.avatar = normUrl(oldStore.avatar);
  if ("social" in oldStore) oldStore.social = normalizeSocial(oldStore.social);

  const rs = await env.DB.batch([
    // 事务：销毁令牌 + 写入审核记录
    env.DB.prepare("DELETE FROM verify_tokens WHERE token=?").bind(vToken),
    env.DB.prepare(
      `INSERT INTO submissions
         (verified_by_real_name, member_id, member_name, changes, old_data, created_at, status)
       VALUES (1, ?, ?, ?, ?, ?, 'pending')`,
    ).bind(
      mrow.id,
      mrow.name,
      JSON.stringify(chgStore),
      JSON.stringify(oldStore),
      nowISO(),
    ),
  ]);
  return OK({ submissionId: rs[1].meta.last_row_id });
}

/* 4.4 POST /api/admin/login */
async function adminLogin(env, request, ip) {
  await assertRateLimit(env, ip, "admin-login", 5, 60_000);
  const body = await readJson(request);
  const pw = typeof body.password === "string" ? body.password : "";
  const expected = env.ADMIN_PASSWORD || "";
  if (!expected)
    throw new ApiError(
      "INTERNAL_ERROR",
      "服务端尚未配置管理密码（ADMIN_PASSWORD）",
      500,
    );
  if (!pw || !timingSafeEqual(pw, expected))
    throw new ApiError("PASSWORD_WRONG", "管理密码错误", 401);

  const token = randomToken("at_");
  await env.DB.prepare(
    "INSERT INTO admin_sessions(token,expires_at) VALUES(?,?)",
  )
    .bind(token, Date.now() + SESSION_TTL_MS)
    .run();
  return OK({
    adminToken: token,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
}

/* 4.5 GET /api/admin/submissions（附录速查表别名 GET /api/submissions 一并支持） */
async function listSubmissions(env, url) {
  const status = url.searchParams.get("status") || "pending";
  const ALLOWED = ["pending", "approved", "rejected"];
  if (!ALLOWED.includes(status)) return OK([]); // 固定行为：非法状态返回空数组（文档允许二选一）
  const { results } = await env.DB.prepare(
    `SELECT id,verified_by_real_name,member_id,member_name,changes,old_data,created_at,status,reason,reviewed_at
       FROM submissions WHERE status=? ORDER BY created_at DESC`,
  )
    .bind(status)
    .all();
  return OK(results.map(submissionRowToObj));
}

async function getSubmission(env, id) {
  const r = await env.DB.prepare("SELECT * FROM submissions WHERE id=?")
    .bind(id)
    .first();
  if (!r) throw new ApiError("NOT_FOUND", "审核记录不存在", 404);
  return r;
}

/* 4.6 POST /api/admin/submissions/{id}/approve */
async function approveSubmission(env, id) {
  const srow = await getSubmission(env, id);
  if (srow.status !== "pending")
    throw new ApiError("ALREADY_REVIEWED", "该审核记录已处理", 409);
  const mrow = await env.DB.prepare("SELECT id FROM members WHERE id=?")
    .bind(srow.member_id)
    .first();
  if (!mrow)
    throw new ApiError(
      "MEMBER_NOT_FOUND",
      "目标成员已被删除，拒绝应用变更",
      404,
    );

  const changes = JSON.parse(srow.changes || "{}");
  const cols = [],
    args = [];
  for (const k of Object.keys(changes)) {
    // last-write-wins，不做冲突检测（§5.2）
    if (!WHITELIST_FIELDS.includes(k)) continue;
    if (k === "tags" || k === "social") {
      cols.push(`${k}=?`);
      args.push(JSON.stringify(changes[k]));
    } else {
      cols.push(`${k}=?`);
      args.push(changes[k]);
    }
  }
  const stmts = [];
  if (cols.length)
    stmts.push(
      env.DB.prepare(`UPDATE members SET ${cols.join(",")} WHERE id=?`).bind(
        ...args,
        srow.member_id,
      ),
    );
  stmts.push(
    env.DB.prepare(
      "UPDATE submissions SET status='approved', reviewed_at=? WHERE id=?",
    ).bind(nowISO(), id),
  );
  await env.DB.batch(stmts);
  return OK({ applied: true });
}

/* 4.7 POST /api/admin/submissions/{id}/reject */
async function rejectSubmission(env, request, id) {
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason)
    throw new ApiError("REASON_REQUIRED", "驳回时必须填写驳回理由", 400);

  const srow = await getSubmission(env, id);
  if (srow.status !== "pending")
    throw new ApiError("ALREADY_REVIEWED", "该审核记录已处理", 409);

  await env.DB.prepare(
    "UPDATE submissions SET status='rejected', reason=?, reviewed_at=? WHERE id=?",
  )
    .bind(reason, nowISO(), id)
    .run(); // 不触碰成员数据
  return OK({ applied: false });
}

/* 4.8 GET /api/admin/members */
async function listMembersAdmin(env) {
  const { results } = await env.DB.prepare(
    "SELECT id,name,generation,role,bio,tags,social,avatar FROM members ORDER BY id",
  ).all();
  return OK(results.map(memberRowToObj)); // 即使管理员也拿不到 realName（§3.4 只进不出）
}

/* 4.9 POST /api/admin/members —— 校验顺序按 §4.9 建议 */
async function createMember(env, request) {
  const body = await readJson(request);

  // ① realName 非空
  const realName = String(body.realName ?? "").trim();
  if (!realName)
    throw new ApiError("FIELD_MISSING", "缺少必填字段 realName", 400);
  // ② realName 唯一
  const lookup = await sha256Lookup(env, realName);
  if (
    await env.DB.prepare("SELECT id FROM members WHERE real_name_lookup=?")
      .bind(lookup)
      .first()
  )
    throw new ApiError("REALNAME_EXISTS", "该真实姓名已登记给其他成员", 409);
  // ③④ name / generation 非空
  if (String(body.name ?? "").trim() === "")
    throw new ApiError("FIELD_MISSING", "缺少必填字段 name", 400);
  if (String(body.generation ?? "").trim() === "")
    throw new ApiError("FIELD_MISSING", "缺少必填字段 generation", 400);
  // ⑤ 其余字段类型校验
  validateFieldValues(body);

  const r = await env.DB.prepare(
    `INSERT INTO members
       (real_name_lookup, real_name_verify, name, generation, role, bio, avatar, tags, social, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      lookup,
      await pbkdf2Hash(realName),
      String(body.name).trim(),
      String(body.generation).trim(),
      body.role ?? "",
      body.bio ?? "",
      normUrl(body.avatar ?? ""),
      Array.isArray(body.tags) ? JSON.stringify(body.tags) : "[]",
      JSON.stringify(normalizeSocial(body.social)),
      nowISO(),
    )
    .run();
  return OK({ id: r.meta.last_row_id });
}

/* 4.10 PUT /api/admin/members/{id} —— 部分更新：缺省=不改；tags/social 整体替换（§3.2） */
async function updateMember(env, request, id) {
  const body = await readJson(request);
  for (const k of Object.keys(body)) {
    if (!WHITELIST_FIELDS.includes(k) && k !== "realName")
      throw new ApiError(
        "FIELD_FORBIDDEN",
        `字段 "${k}" 不能通过该接口修改`,
        400,
      );
  }
  validateFieldValues(body); // name/generation 出现则必须非空等规则同样生效

  const mrow = await env.DB.prepare("SELECT * FROM members WHERE id=?")
    .bind(id)
    .first();
  if (!mrow) throw new ApiError("MEMBER_NOT_FOUND", "成员不存在", 404);

  const cols = [],
    args = [];
  // realName 特殊：缺省或空串=不变（无清除语义）；非空=覆盖登记，且需唯一性校验排除自身
  const rnRaw = String(body.realName ?? "").trim();
  const rnChange = "realName" in body && rnRaw !== "";
  if (rnChange) {
    const lookup = await sha256Lookup(env, rnRaw);
    if (
      await env.DB.prepare(
        "SELECT id FROM members WHERE real_name_lookup=? AND id<>?",
      )
        .bind(lookup, id)
        .first()
    )
      throw new ApiError("REALNAME_EXISTS", "该真实姓名已登记给其他成员", 409);
  }

  for (const k of WHITELIST_FIELDS) {
    if (!(k in body)) continue;
    if (k === "tags") {
      cols.push("tags=?");
      args.push(JSON.stringify(body.tags));
    } else if (k === "social") {
      cols.push("social=?");
      args.push(JSON.stringify(normalizeSocial(body.social)));
    } else if (k === "avatar") {
      cols.push("avatar=?");
      args.push(normUrl(body.avatar));
    } else {
      cols.push(`${k}=?`);
      args.push(body[k]);
    }
  }
  if (rnChange) {
    // 旧哈希作废，此后须以新姓名验证
    cols.push("real_name_lookup=?");
    args.push(await sha256Lookup(env, rnRaw));
    cols.push("real_name_verify=?");
    args.push(await pbkdf2Hash(rnRaw));
  }
  if (cols.length) {
    // 完全无可改字段视为空操作，成功返回
    await env.DB.prepare(`UPDATE members SET ${cols.join(",")} WHERE id=?`)
      .bind(...args, id)
      .run();
  }
  return OK({ updated: true });
}

/* 4.11 DELETE /api/admin/members/{id} —— 原子级联：作废 pending（§4.11 / §5.2） */
async function deleteMember(env, id) {
  const mrow = await env.DB.prepare("SELECT id FROM members WHERE id=?")
    .bind(id)
    .first();
  if (!mrow) throw new ApiError("MEMBER_NOT_FOUND", "成员不存在", 404); // 非幂等：重复删除 404

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE submissions
          SET status='rejected', reason='目标成员已被删除，提交自动作废', reviewed_at=?
        WHERE member_id=? AND status='pending'`,
    ).bind(nowISO(), id),
    env.DB.prepare("DELETE FROM members WHERE id=?").bind(id), // 行删除即同时清除其姓名哈希，姓名释放
  ]);
  return OK({ deleted: true });
}

/* =============== 路由入口 =============== */
export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: CORS });

      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      let p = url.pathname.replace(/\/+$/, "");

      if (p !== "/api" && !p.startsWith("/api/"))
        return ERR("NOT_FOUND", "Not Found", 404);

      const seg = p.split("/").filter(Boolean); // 例：['api','admin','submissions','12','approve']
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";

      /* ---------- 公开接口 ---------- */
      if (seg[1] === "members" && seg.length === 2 && method === "GET")
        return await listMembers(env);

      if (seg[1] === "verify-name" && seg.length === 2 && method === "POST")
        return await verifyName(env, request, ip);

      if (seg[1] === "submissions") {
        if (seg.length === 2 && method === "POST")
          return await createSubmission(env, request, ip);
        if (seg.length === 2 && method === "GET") {
          // 附录速查表中的管理端别名
          await requireAdmin(env, request);
          return await listSubmissions(env, url);
        }
      }

      /* ---------- 管理接口 ---------- */
      if (seg[1] === "admin") {
        if (seg.length === 3 && seg[2] === "login" && method === "POST")
          return await adminLogin(env, request, ip);

        await requireAdmin(env, request); // 其余 /admin/* 一律需要 Bearer adminToken

        if (seg[2] === "submissions") {
          if (seg.length === 3 && method === "GET")
            return await listSubmissions(env, url);
          if (seg.length === 5 && seg[4] === "approve" && method === "POST")
            return await approveSubmission(env, Number(seg[3]));
          if (seg.length === 5 && seg[4] === "reject" && method === "POST")
            return await rejectSubmission(env, request, Number(seg[3]));
        }
        if (seg[2] === "members") {
          if (seg.length === 3 && method === "GET")
            return await listMembersAdmin(env);
          if (seg.length === 3 && method === "POST")
            return await createMember(env, request);
          if (seg.length === 4 && method === "PUT")
            return await updateMember(env, request, Number(seg[3]));
          if (seg.length === 4 && method === "DELETE")
            return await deleteMember(env, Number(seg[3]));
        }
        return ERR("NOT_FOUND", "Not Found", 404);
      }

      return ERR("NOT_FOUND", "Not Found", 404);
    } catch (e) {
      if (e instanceof ApiError) return ERR(e.code, e.message, e.status);
      console.error("[INTERNAL]", (e && e.stack) || e);
      return ERR("INTERNAL_ERROR", "服务器内部错误", 500);
    }
  },
};
