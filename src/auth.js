const crypto = require('crypto');
const { q } = require('./db');

const SESSION_HOURS = 12;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, salt, hex] = String(stored).split('$');
  if (!salt || !hex) return false;
  const a = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

async function createSession(res, facultyId, secure) {
  const t = token();
  await q("INSERT INTO faculty_sessions(token_hash, faculty_id, expires_at) VALUES ($1,$2, now() + $3 * interval '1 hour')", [sha256(t), facultyId, SESSION_HOURS]);
  res.setHeader('Set-Cookie', `ed_fac=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`);
}

async function destroySession(req, res) {
  const t = cookie(req, 'ed_fac');
  if (t) await q('DELETE FROM faculty_sessions WHERE token_hash=$1', [sha256(t)]);
  res.setHeader('Set-Cookie', 'ed_fac=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

// Faculty-only API guard. SameSite=Strict cookie + required custom header blocks CSRF.
function requireFaculty(role) {
  return async (req, res, next) => {
    try {
      if (req.get('X-Requested-With') !== 'ExamDesk') return res.status(403).json({ error: 'Forbidden' });
      const t = cookie(req, 'ed_fac');
      if (!t) return res.status(401).json({ error: 'Please sign in' });
      const { rows } = await q(
        `SELECT f.id, f.email, f.name, f.role, f.department FROM faculty_sessions s JOIN faculty f ON f.id = s.faculty_id
         WHERE s.token_hash=$1 AND s.expires_at > now() AND f.active`, [sha256(t)]);
      if (!rows[0]) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
      if (role && rows[0].role !== role) return res.status(403).json({ error: 'Administrator access required' });
      req.faculty = rows[0];
      next();
    } catch (e) { next(e); }
  };
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, requireFaculty, sha256, token };
