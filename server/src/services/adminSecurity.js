const crypto = require("crypto");
const { query } = require("../config/postgres");

const SESSION_TTL_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.ADMIN_SESSION_TTL_MS || 12 * 60 * 60 * 1000)
);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();

let schemaPromise = null;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function scrypt(value, salt) {
  return crypto.scryptSync(String(value), salt, 64);
}

function verifyPassword(password) {
  const encoded = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
  if (encoded) {
    const [scheme, saltHex, digestHex] = encoded.split("$");
    if (scheme !== "scrypt" || !saltHex || !digestHex) return false;
    try {
      const actual = scrypt(password, Buffer.from(saltHex, "hex"));
      const expected = Buffer.from(digestHex, "hex");
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch (_error) {
      return false;
    }
  }

  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) return false;
  const expected = Buffer.from(String(configured));
  const actual = Buffer.from(String(password || ""));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function verifyCredentials(username, password) {
  const configuredUsername = String(process.env.ADMIN_USERNAME || "admin");
  const actual = Buffer.from(String(username || "").trim());
  const expected = Buffer.from(configuredUsername);
  const usernameMatches = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  return usernameMatches && verifyPassword(password);
}

async function ensureAdminSecuritySchema() {
  if (!schemaPromise) {
    schemaPromise = query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ,
        ip_address TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx
        ON admin_sessions (expires_at) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id BIGSERIAL PRIMARY KEY,
        username TEXT,
        action TEXT NOT NULL,
        method TEXT,
        path TEXT,
        status_code INTEGER,
        ip_address TEXT,
        user_agent TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx
        ON admin_audit_log (created_at DESC);
    `).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function bearerToken(req) {
  const authorization = String(req.headers?.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function authenticateToken(token) {
  if (!token) return null;
  await ensureAdminSecuritySchema();
  const result = await query(`
    UPDATE admin_sessions
    SET last_used_at = NOW()
    WHERE token_hash = $1
      AND revoked_at IS NULL
      AND expires_at > NOW()
    RETURNING username, created_at, expires_at
  `, [sha256(token)]);
  return result.rows[0] || null;
}

async function createSession(username, req) {
  await ensureAdminSecuritySchema();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(`
    INSERT INTO admin_sessions (
      token_hash, username, expires_at, ip_address, user_agent
    ) VALUES ($1, $2, $3, $4, $5)
  `, [
    sha256(token),
    username,
    expiresAt,
    String(req.ip || "").slice(0, 128),
    String(req.headers["user-agent"] || "").slice(0, 500),
  ]);
  return { token, expiresAt };
}

async function revokeSession(token) {
  if (!token) return;
  await query(`UPDATE admin_sessions SET revoked_at = NOW() WHERE token_hash = $1`, [sha256(token)]);
}

function loginAllowed(req) {
  const key = String(req.ip || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((time) => now - time < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(key, recent);
    return false;
  }
  recent.push(now);
  loginAttempts.set(key, recent);
  return true;
}

function clearLoginAttempts(req) {
  loginAttempts.delete(String(req.ip || req.socket?.remoteAddress || "unknown"));
}

async function requireAdmin(req, res, next) {
  try {
    const session = await authenticateToken(bearerToken(req));
    if (!session) return res.status(401).json({ success: false, error: "Admin authentication required." });
    req.admin = session;
    return next();
  } catch (error) {
    console.error("Admin authentication error:", error);
    return res.status(503).json({ success: false, error: "Admin authentication is temporarily unavailable." });
  }
}

async function writeAudit({ req, action, statusCode, details = {} }) {
  try {
    await ensureAdminSecuritySchema();
    await query(`
      INSERT INTO admin_audit_log (
        username, action, method, path, status_code, ip_address, user_agent, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    `, [
      req.admin?.username || null,
      String(action).slice(0, 160),
      req.method || null,
      req.originalUrl || req.path || null,
      statusCode || null,
      String(req.ip || "").slice(0, 128),
      String(req.headers?.["user-agent"] || "").slice(0, 500),
      JSON.stringify(details || {}),
    ]);
  } catch (error) {
    console.error("Admin audit write error:", error);
  }
}

module.exports = {
  authenticateToken,
  bearerToken,
  clearLoginAttempts,
  createSession,
  ensureAdminSecuritySchema,
  loginAllowed,
  requireAdmin,
  revokeSession,
  verifyCredentials,
  writeAudit,
  testUtils: { sha256, verifyPassword },
};
