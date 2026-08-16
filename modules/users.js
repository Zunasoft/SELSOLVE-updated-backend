/**
 * Console user management — who may sign in to the Super Admin console, and
 * what they may do once they are in.
 *
 * Sign-in is passwordless (email + one-time code), so there is no credential to
 * issue or reset here. A row in the SuperAdmin collection with
 * `status: 'active'` *is* the login access: creating one grants it, flipping
 * the status to `revoked` takes it away, and deleting the row removes the
 * account entirely.
 *
 * Revocation is immediate rather than eventual: auth.js re-reads the account
 * from the master database on every single request, so a revoked operator is
 * locked out on their very next click — their existing token is not waited out.
 */

const express = require('express');
const { models, addAuditLog, SEED_SUPER_ADMIN_EMAIL } = require('../db');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Roles — the single definition the backend guards with and the console
 * renders its role picker from.
 * ------------------------------------------------------------------ */

const ROLE_CATALOG = [
  {
    id: 'SuperAdmin',
    label: 'Super Admin',
    description: 'Full control of the platform, including granting and revoking console access.',
    canManageUsers: true,
    readOnly: false
  },
  {
    id: 'Admin',
    label: 'Administrator',
    description: 'Full control of shops, plans, devices and billing — but cannot manage console users.',
    canManageUsers: false,
    readOnly: false
  },
  {
    id: 'Viewer',
    label: 'Viewer (read-only)',
    description: 'Can open every screen and read every report, but cannot change anything.',
    canManageUsers: false,
    readOnly: true
  }
];

const ROLE_IDS = ROLE_CATALOG.map((r) => r.id);

const roleOf = (role) => ROLE_CATALOG.find((r) => r.id === role) || ROLE_CATALOG[0];

/** Permissions are derived from the stored role, never sent by the client. */
const permissionsFor = (admin) => {
  const role = roleOf(admin?.role);
  return {
    role: role.id,
    roleLabel: role.label,
    canManageUsers: role.canManageUsers,
    readOnly: role.readOnly
  };
};

const actorOf = (req) => req.admin?.email || 'SuperAdmin';
const handler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const iso = () => new Date().toISOString();

/**
 * A row written before this module existed carries no role and possibly a
 * legacy status word ("inactive", "disabled"). Both are filled in on read, so
 * an older account never renders as role-less or as neither active nor revoked.
 */
const publicUser = (user, currentEmail) => {
  const role = roleOf(user.role);
  const isSeed = user.email === SEED_SUPER_ADMIN_EMAIL;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: role.id,
    roleLabel: role.label,
    status: user.status === 'active' ? 'active' : 'revoked',
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    createdBy: user.createdBy,
    revokedAt: user.revokedAt,
    revokedBy: user.revokedBy,
    isSelf: user.email === currentEmail,
    // The seed account is re-created by db.js on every boot, so deleting it
    // would only make it reappear — the console disables the button instead.
    isSeedAccount: isSeed,
    canDelete: !isSeed && user.email !== currentEmail
  };
};

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

/** Only a role carrying `canManageUsers` may reach the routes below. */
const requireUserAdmin = (req, res, next) => {
  if (roleOf(req.admin?.role).canManageUsers) return next();
  return res.status(403).json({
    success: false,
    code: 'FORBIDDEN',
    message: 'Only a Super Admin can manage console users.'
  });
};

/**
 * Read-only roles may call GET and nothing else.
 *
 * Applied across the whole admin API rather than per-route, so a screen added
 * later is covered without anyone having to remember to guard it.
 */
const enforceReadOnly = (req, res, next) => {
  if (!roleOf(req.admin?.role).readOnly) return next();
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  return res.status(403).json({
    success: false,
    code: 'READ_ONLY',
    message: 'Your account has read-only access. Ask a Super Admin if you need to make changes.'
  });
};

/* ------------------------------------------------------------------ *
 * Shared checks
 *
 * The console must never be able to lock itself out: at least one active
 * Super Admin has to survive every revoke, delete and demotion.
 * ------------------------------------------------------------------ */

const countActiveSuperAdmins = async (excludeId) => {
  const query = { role: 'SuperAdmin', status: 'active' };
  if (excludeId) query.id = { $ne: excludeId };
  return models.SuperAdmin.countDocuments(query);
};

/**
 * Would this change leave the platform with no one able to manage access?
 * Returns a message to refuse with, or null when the change is safe.
 */
const wouldOrphanConsole = async (user, { nextRole, nextStatus }) => {
  const wasManager = roleOf(user.role).canManageUsers && user.status === 'active';
  if (!wasManager) return null;

  const stillManager =
    roleOf(nextRole ?? user.role).canManageUsers && (nextStatus ?? user.status) === 'active';
  if (stillManager) return null;

  const others = await countActiveSuperAdmins(user.id);
  if (others > 0) return null;

  return 'This is the last active Super Admin. Grant Super Admin access to someone else first, otherwise nobody could manage the console.';
};

const findUser = async (id) => models.SuperAdmin.findOne({ $or: [{ id }, { email: normalizeEmail(id) }] }).lean();

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/** The role catalogue the console renders its role picker from. */
router.get('/users/roles', (req, res) => {
  res.json({ success: true, data: ROLE_CATALOG });
});

// List every console user.
router.get(
  '/users',
  handler(async (req, res) => {
    const users = await models.SuperAdmin.find().sort({ createdAt: -1 }).lean();
    const rows = users.map((u) => publicUser(u, req.admin?.email));

    res.json({
      success: true,
      data: rows,
      roles: ROLE_CATALOG,
      summary: {
        total: rows.length,
        active: rows.filter((u) => u.status === 'active').length,
        revoked: rows.filter((u) => u.status === 'revoked').length,
        superAdmins: rows.filter((u) => u.role === 'SuperAdmin').length
      }
    });
  })
);

// Grant console login access to a new person.
router.post(
  '/users',
  requireUserAdmin,
  handler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const role = req.body.role || 'Admin';

    if (!name) {
      return res.status(400).json({ success: false, message: 'A full name is required.' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }
    if (!ROLE_IDS.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${ROLE_IDS.join(', ')}.` });
    }

    const existing = await models.SuperAdmin.findOne({ email }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message:
          existing.status === 'active'
            ? `${email} already has console access.`
            : `${email} already exists but their access is revoked — restore it instead of creating a second account.`
      });
    }

    // The address is the credential, so a shop owner's address must not double
    // as a console login: one inbox would then open both consoles.
    const tenantClash = await models.Tenant.findOne({ email }).lean();
    if (tenantClash) {
      return res.status(409).json({
        success: false,
        message: `${email} is already registered as the owner of the shop "${tenantClash.name}". Use a different address for console access.`
      });
    }

    const user = {
      id: `sa_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name,
      email,
      role,
      status: 'active',
      lastLoginAt: null,
      createdBy: actorOf(req)
    };

    await models.SuperAdmin.create(user);

    await addAuditLog(
      'CONSOLE_USER_CREATED',
      actorOf(req),
      `Granted ${roleOf(role).label} console access to ${name} <${email}>`
    );

    res.status(201).json({
      success: true,
      message: `${name} can now sign in to the console with ${email}. No password is issued — they request a one-time code at the login screen.`,
      data: publicUser(user, req.admin?.email)
    });
  })
);

// Edit a console user's name or role.
router.put(
  '/users/:id',
  requireUserAdmin,
  handler(async (req, res) => {
    const user = await findUser(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Console user not found.' });

    const update = {};
    const changes = [];

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ success: false, message: 'A full name is required.' });
      if (name !== user.name) {
        update.name = name;
        changes.push(`name "${user.name}" → "${name}"`);
      }
    }

    if (req.body.role !== undefined && req.body.role !== user.role) {
      if (!ROLE_IDS.includes(req.body.role)) {
        return res.status(400).json({ success: false, message: `Role must be one of: ${ROLE_IDS.join(', ')}.` });
      }
      if (user.email === req.admin?.email) {
        return res.status(400).json({
          success: false,
          message: 'You cannot change your own role. Ask another Super Admin to do it.'
        });
      }
      const orphan = await wouldOrphanConsole(user, { nextRole: req.body.role });
      if (orphan) return res.status(400).json({ success: false, message: orphan });

      update.role = req.body.role;
      changes.push(`role ${roleOf(user.role).label} → ${roleOf(req.body.role).label}`);
    }

    // The address is the credential, so changing it would hand the account to a
    // different inbox. Revoke and re-grant instead — that leaves an audit trail.
    if (req.body.email && normalizeEmail(req.body.email) !== user.email) {
      return res.status(400).json({
        success: false,
        message: 'An email address cannot be edited — it is the login credential. Revoke this account and grant access to the new address instead.'
      });
    }

    if (!changes.length) {
      return res.json({ success: true, message: 'Nothing to update.', data: publicUser(user, req.admin?.email) });
    }

    const updated = await models.SuperAdmin.findOneAndUpdate(
      { id: user.id },
      { $set: update },
      { new: true, lean: true }
    );

    await addAuditLog(
      'CONSOLE_USER_UPDATED',
      actorOf(req),
      `Updated console user ${updated.email}: ${changes.join(', ')}`
    );

    res.json({
      success: true,
      message: `${updated.name}'s console account was updated.`,
      data: publicUser(updated, req.admin?.email)
    });
  })
);

// Revoke or restore login access.
router.patch(
  '/users/:id/status',
  requireUserAdmin,
  handler(async (req, res) => {
    const status = req.body.status === 'active' ? 'active' : 'revoked';

    const user = await findUser(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Console user not found.' });

    if (user.email === req.admin?.email && status === 'revoked') {
      return res.status(400).json({
        success: false,
        message: 'You cannot revoke your own access — you would be signed out with no way back in.'
      });
    }

    const currentStatus = user.status === 'active' ? 'active' : 'revoked';
    if (currentStatus === status) {
      return res.json({
        success: true,
        message: `${user.name}'s access is already ${status}.`,
        data: publicUser(user, req.admin?.email)
      });
    }

    const orphan = await wouldOrphanConsole(user, { nextStatus: status });
    if (orphan) return res.status(400).json({ success: false, message: orphan });

    const update =
      status === 'revoked'
        ? { status, revokedAt: iso(), revokedBy: actorOf(req) }
        : { status, revokedAt: null, revokedBy: null };

    const updated = await models.SuperAdmin.findOneAndUpdate(
      { id: user.id },
      { $set: update },
      { new: true, lean: true }
    );

    // A login code already sitting in their inbox would otherwise still work
    // for its full lifetime, so the pending code goes with the access.
    if (status === 'revoked') {
      await models.Otp.deleteOne({ email: user.email, scope: 'admin' });
    }

    await addAuditLog(
      status === 'revoked' ? 'CONSOLE_USER_REVOKED' : 'CONSOLE_USER_RESTORED',
      actorOf(req),
      status === 'revoked'
        ? `Revoked console access for ${user.name} <${user.email}>`
        : `Restored console access for ${user.name} <${user.email}>`,
      status === 'revoked' ? 'BLOCKED' : 'SUCCESS'
    );

    res.json({
      success: true,
      message:
        status === 'revoked'
          ? `${updated.name} has been signed out and can no longer request a login code.`
          : `${updated.name} can sign in again.`,
      data: publicUser(updated, req.admin?.email)
    });
  })
);

// Delete a console user outright.
router.delete(
  '/users/:id',
  requireUserAdmin,
  handler(async (req, res) => {
    const user = await findUser(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Console user not found.' });

    if (user.email === req.admin?.email) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }

    if (user.email === SEED_SUPER_ADMIN_EMAIL) {
      return res.status(400).json({
        success: false,
        message: 'This is the platform seed account and is re-created every time the server boots. Revoke its access instead of deleting it.'
      });
    }

    const orphan = await wouldOrphanConsole(user, { nextStatus: 'revoked' });
    if (orphan) return res.status(400).json({ success: false, message: orphan });

    await Promise.all([
      models.SuperAdmin.deleteOne({ id: user.id }),
      models.Otp.deleteOne({ email: user.email, scope: 'admin' })
    ]);

    await addAuditLog(
      'CONSOLE_USER_DELETED',
      actorOf(req),
      `Deleted console user ${user.name} <${user.email}> (${roleOf(user.role).label})`,
      'BLOCKED'
    );

    res.json({ success: true, message: `${user.name}'s console account was deleted.` });
  })
);

module.exports = {
  usersRouter: router,
  ROLE_CATALOG,
  ROLE_IDS,
  roleOf,
  permissionsFor,
  requireUserAdmin,
  enforceReadOnly
};
