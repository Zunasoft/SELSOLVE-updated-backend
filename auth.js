/**
 * Super Admin console authentication — passwordless email + one-time code.
 *
 * Both the operator accounts and the login codes live in the master database.
 * Nothing is held in process memory: the request that asks for a code and the
 * request that verifies it are frequently served by two different serverless
 * instances, and an in-memory code would simply not be there the second time.
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { models, addAuditLog, ensureMasterDB, requireMasterDB, getOtpExpiryMinutes } = require('./db');
const { sendOtpEmail, isSmtpConfigured } = require('./mailer');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_zunasoft_2026';
const SESSION_TTL = process.env.ADMIN_SESSION_TTL || '12h';

const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000;

const OTP_SCOPE = 'admin';

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

/** Super Admin accounts are read from the master database on every check. */
const findSuperAdmin = async (email) => {
  const address = normalizeEmail(email);
  if (!address) return null;
  return models.SuperAdmin.findOne({ email: address }).lean();
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
const requireSuperAdmin = async (req, res, next) => {
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

  // The account is re-checked against the database on every call, so revoking
  // an operator takes effect immediately rather than when their token expires.
  if (!(await ensureMasterDB())) {
    return res.status(503).json({
      success: false,
      code: 'MASTER_DB_UNAVAILABLE',
      message: 'The master database is unreachable. Please try again in a moment.'
    });
  }

  let admin;
  try {
    admin = await findSuperAdmin(payload.email);
  } catch (err) {
    console.error('[Super Admin lookup error]:', err.message);
    return res.status(503).json({ success: false, code: 'MASTER_DB_UNAVAILABLE', message: 'Could not verify your account. Please try again.' });
  }

  if (!admin || admin.status !== 'active') {
    return res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'This Super Admin account is no longer active.' });
  }

  req.admin = admin;
  next();
};

// --- ROUTES ---
const router = express.Router();

// Every route below reads or writes the master database.
router.use(requireMasterDB);

router.post('/send-otp', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }

    const admin = await findSuperAdmin(email);
    if (!admin) {
      await addAuditLog('ADMIN_OTP_DENIED', email, 'Login code requested for an unrecognised Super Admin email', 'FAILED');
      return res.status(404).json({
        success: false,
        message: 'This email is not registered as a Super Admin account.'
      });
    }

    if (admin.status !== 'active') {
      await addAuditLog('ADMIN_OTP_BLOCKED', email, 'Login code requested for a disabled Super Admin account', 'BLOCKED');
      return res.status(403).json({ success: false, message: 'This Super Admin account has been disabled.' });
    }

    const existing = await models.Otp.findOne({ email, scope: OTP_SCOPE }).lean();
    if (existing && Date.now() - new Date(existing.issuedAt).getTime() < RESEND_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - new Date(existing.issuedAt).getTime())) / 1000);
      return res.status(429).json({
        success: false,
        message: `A code was just sent. Please wait ${waitSeconds}s before requesting another.`,
        retryAfterSeconds: waitSeconds
      });
    }

    const otp = generateOtp();
    const expiryMinutes = await getOtpExpiryMinutes();

    // Replaces any earlier code for this address — one live code at a time.
    await models.Otp.updateOne(
      { email, scope: OTP_SCOPE },
      {
        $set: {
          email,
          scope: OTP_SCOPE,
          otpHash: hashOtp(otp),
          attempts: 0,
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000)
        }
      },
      { upsert: true }
    );

    const mailResult = await sendOtpEmail({
      to: email,
      otp,
      expiryMinutes,
      purpose: 'superadmin',
      recipientLabel: admin.name
    });

    await addAuditLog(
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
  } catch (err) {
    next(err);
  }
});

router.post('/verify-otp', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || '').trim();

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and the 6-digit code are both required.' });
    }

    const record = await models.Otp.findOne({ email, scope: OTP_SCOPE }).lean();
    if (!record || new Date(record.expiresAt).getTime() < Date.now()) {
      if (record) await models.Otp.deleteOne({ email, scope: OTP_SCOPE });
      await addAuditLog('ADMIN_LOGIN_FAILED', email, 'Verification attempted with no active (or expired) login code', 'FAILED');
      return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
    }

    if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
      await models.Otp.deleteOne({ email, scope: OTP_SCOPE });
      await addAuditLog('ADMIN_LOGIN_LOCKED', email, 'Login code invalidated after too many incorrect attempts', 'BLOCKED');
      return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }

    if (!safeEqual(hashOtp(otp), record.otpHash)) {
      // The counter is incremented in the database, so attempts are counted
      // across instances rather than per-process.
      const updated = await models.Otp.findOneAndUpdate(
        { email, scope: OTP_SCOPE },
        { $inc: { attempts: 1 } },
        { new: true, lean: true }
      );
      const remaining = MAX_VERIFY_ATTEMPTS - (updated?.attempts ?? record.attempts + 1);
      await addAuditLog('ADMIN_LOGIN_FAILED', email, `Incorrect login code entered (${Math.max(remaining, 0)} attempt(s) left)`, 'FAILED');
      return res.status(400).json({
        success: false,
        message: remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
          : 'Incorrect code. Please request a new one.',
        attemptsRemaining: Math.max(remaining, 0)
      });
    }

    const admin = await findSuperAdmin(email);
    if (!admin || admin.status !== 'active') {
      return res.status(403).json({ success: false, message: 'This Super Admin account is no longer active.' });
    }

    const lastLoginAt = new Date().toISOString();
    await Promise.all([
      models.Otp.deleteOne({ email, scope: OTP_SCOPE }),
      models.SuperAdmin.updateOne({ email }, { $set: { lastLoginAt } })
    ]);

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

    await addAuditLog('ADMIN_LOGIN_SUCCESS', email, 'Super Admin signed in to the control console');

    res.json({
      success: true,
      message: 'Login verified. Welcome back.',
      token,
      expiresIn: SESSION_TTL,
      admin: publicAdmin({ ...admin, lastLoginAt })
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireSuperAdmin, (req, res) => {
  res.json({ success: true, admin: publicAdmin(req.admin) });
});

router.post('/logout', requireSuperAdmin, async (req, res) => {
  await addAuditLog('ADMIN_LOGOUT', req.admin.email, 'Super Admin signed out of the control console');
  res.json({ success: true, message: 'Signed out successfully.' });
});

module.exports = {
  authRouter: router,
  requireSuperAdmin,
  findSuperAdmin,
  hashOtp,
  generateOtp,
  normalizeEmail,
  isSmtpConfigured
};
