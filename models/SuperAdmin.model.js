/**
 * Console user (Super Admin) — Mongoose Schema.
 *
 * One row per person who is allowed to sign in to the Super Admin console.
 * There is no password column: sign-in is email + one-time code, so *having a
 * row here with `status: 'active'` is what login access means*. Revoking a
 * person is therefore a status change, not a credential reset.
 *
 * `role` decides what that person may do once inside — see ROLE_CATALOG in
 * modules/users.js, which is the single place the permissions are defined.
 */

const mongoose = require('mongoose');

const superAdminSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    role: { type: String, default: 'SuperAdmin', enum: ['SuperAdmin', 'Admin', 'Viewer'] },
    status: { type: String, default: 'active', enum: ['active', 'revoked'] },
    lastLoginAt: { type: String, default: null },

    // Who granted the access, and who took it away — the console user table
    // shows both, so an operator can answer "why does this person have a login?"
    createdBy: { type: String, default: null },
    revokedAt: { type: String, default: null },
    revokedBy: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.models.SuperAdmin || mongoose.model('SuperAdmin', superAdminSchema);
