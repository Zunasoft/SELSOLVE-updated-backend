const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { memoryDb, addAuditLog } = require('./db');
const { sendOtpEmail, isSmtpConfigured } = require('./mailer');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_zunasoft_2026';
const SESSION_TTL = process.env.ADMIN_SESSION_TTL || '12h';

const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000;

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');

const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const generateOtp = () => String(crypto.randomInt(100000, 1000000));

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const getOtpExpiryMinutes = () => Number(memoryDb.settings?.otpExpiryMinutes) || 10;

const findSuperAdmin = (email) =>
  memoryDb.superAdmins.find((a) => a.email === normalizeEmail(email));

const pruneExpiredOtps = () => {
  memoryDb.adminOtps = memoryDb.adminOtps.filter((o) => o.expiresAt > Date.now());
};

const publicAdmin = (admin) => ({
  id: admin.id,
  name: admin.name,
  email: admin.email,
  role: admin.role,
  status: admin.status,
  lastLoginAt: admin.lastLoginAt
});

// --- JWT GUARD ---
const requireSuperAdmin = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ success: false, code: 'NO_TOKEN', message: 'Authentication required. Please sign in.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      message: expired ? 'Your session has expired. Please sign in again.' : 'Invalid session token.'
    });
  }

  if (payload.role !== 'SuperAdmin' || payload.scope !== 'admin-console') {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Super Admin privileges required.' });
  }

  const admin = findSuperAdmin(payload.email);
  if (!admin || admin.status !== 'active') {
    return res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'This Super Admin account is no longer active.' });
  }

  req.admin = admin;
  next();
};

// --- ROUTES ---
const router = express.Router();

router.post('/send-otp', async (req, res) => {
  const email = normalizeEmail(req.body.email);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required.' });
  }

  const admin = findSuperAdmin(email);
  if (!admin) {
    addAuditLog('ADMIN_OTP_DENIED', email, 'Login code requested for an unrecognised Super Admin email', 'FAILED');
    return res.status(404).json({
      success: false,
      message: 'This email is not registered as a Super Admin account.'
    });
  }

  if (admin.status !== 'active') {
    addAuditLog('ADMIN_OTP_BLOCKED', email, 'Login code requested for a disabled Super Admin account', 'BLOCKED');
    return res.status(403).json({ success: false, message: 'This Super Admin account has been disabled.' });
  }

  pruneExpiredOtps();

  const existing = memoryDb.adminOtps.find((o) => o.email === email);
  if (existing && Date.now() - existing.issuedAt < RESEND_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - existing.issuedAt)) / 1000);
    return res.status(429).json({
      success: false,
      message: `A code was just sent. Please wait ${waitSeconds}s before requesting another.`,
      retryAfterSeconds: waitSeconds
    });
  }

  const otp = generateOtp();
  const expiryMinutes = getOtpExpiryMinutes();

  const record = {
    email,
    otpHash: hashOtp(otp),
    issuedAt: Date.now(),
    expiresAt: Date.now() + expiryMinutes * 60 * 1000,
    attempts: 0
  };

  memoryDb.adminOtps = memoryDb.adminOtps.filter((o) => o.email !== email);
  memoryDb.adminOtps.push(record);

  const mailResult = await sendOtpEmail({
    to: email,
    otp,
    expiryMinutes,
    purpose: 'superadmin',
    recipientLabel: admin.name
  });

  addAuditLog(
    'ADMIN_OTP_SENT',
    email,
    mailResult.delivered
      ? 'Super Admin login code emailed via SMTP'
      : `Super Admin login code generated (email not delivered: ${mailResult.reason})`,
    mailResult.delivered ? 'SUCCESS' : 'WARNING'
  );

  const exposeCode = !mailResult.delivered && !IS_PRODUCTION;

  res.json({
    success: true,
    message: mailResult.delivered
      ? `A 6-digit login code has been sent to ${email}.`
      : exposeCode
        ? `Login code generated for ${email}. SMTP is not configured, so the code is shown below and printed to the server console.`
        : `Login code generated for ${email}, but the email could not be delivered. Please contact your platform administrator.`,
    emailDelivered: mailResult.delivered,
    expiresInMinutes: expiryMinutes,
    admin: { name: admin.name, email: admin.email },
    devOtp: exposeCode ? otp : undefined
  });
});

router.post('/verify-otp', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').trim();

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'Email and the 6-digit code are both required.' });
  }

  pruneExpiredOtps();

  const record = memoryDb.adminOtps.find((o) => o.email === email);
  if (!record) {
    addAuditLog('ADMIN_LOGIN_FAILED', email, 'Verification attempted with no active (or expired) login code', 'FAILED');
    return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
  }

  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    memoryDb.adminOtps = memoryDb.adminOtps.filter((o) => o.email !== email);
    addAuditLog('ADMIN_LOGIN_LOCKED', email, 'Login code invalidated after too many incorrect attempts', 'BLOCKED');
    return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
  }

  if (!safeEqual(hashOtp(otp), record.otpHash)) {
    record.attempts += 1;
    const remaining = MAX_VERIFY_ATTEMPTS - record.attempts;
    addAuditLog('ADMIN_LOGIN_FAILED', email, `Incorrect login code entered (${remaining} attempt(s) left)`, 'FAILED');
    return res.status(400).json({
      success: false,
      message: remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Incorrect code. Please request a new one.',
      attemptsRemaining: Math.max(remaining, 0)
    });
  }

  const admin = findSuperAdmin(email);
  if (!admin || admin.status !== 'active') {
    return res.status(403).json({ success: false, message: 'This Super Admin account is no longer active.' });
  }

  memoryDb.adminOtps = memoryDb.adminOtps.filter((o) => o.email !== email);
  admin.lastLoginAt = new Date().toISOString();

  const token = jwt.sign(
    {
      sub: admin.id,
      email: admin.email,
      name: admin.name,
      role: 'SuperAdmin',
      scope: 'admin-console'
    },
    JWT_SECRET,
    { expiresIn: SESSION_TTL }
  );

  addAuditLog('ADMIN_LOGIN_SUCCESS', email, 'Super Admin signed in to the control console');

  res.json({
    success: true,
    message: 'Login verified. Welcome back.',
    token,
    expiresIn: SESSION_TTL,
    admin: publicAdmin(admin)
  });
});

router.get('/me', requireSuperAdmin, (req, res) => {
  res.json({ success: true, admin: publicAdmin(req.admin) });
});

router.post('/logout', requireSuperAdmin, (req, res) => {
  addAuditLog('ADMIN_LOGOUT', req.admin.email, 'Super Admin signed out of the control console');
  res.json({ success: true, message: 'Signed out successfully.' });
});

module.exports = {
  authRouter: router,
  requireSuperAdmin,
  hashOtp,
  generateOtp,
  normalizeEmail,
  getOtpExpiryMinutes,
  isSmtpConfigured
};
