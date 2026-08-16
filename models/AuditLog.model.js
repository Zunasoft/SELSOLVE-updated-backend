const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    timestamp: { type: String, default: () => new Date().toISOString() },
    action: { type: String, required: true },
    actor: { type: String, default: 'SuperAdmin' },
    description: { type: String, required: true },
    ip: { type: String, default: '127.0.0.1' },
    status: { type: String, default: 'SUCCESS' }
  },
  { timestamps: true }
);

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
