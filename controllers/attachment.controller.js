/**
 * Generic file attachments — a vendor's paper invoice photo/PDF, a delivery
 * challan, anything worth keeping against a purchase, purchase order, or
 * vendor credit. Same storage posture as product images (upload.controller.js):
 * the binary lives in the tenant's own database, nothing touches local disk,
 * and only lightweight metadata (filename/url/size) is mirrored onto the
 * owning record so it round-trips through the normal tenant-store persistence
 * without ever putting file bytes into that JSON document.
 */

const crypto = require('crypto');
const path = require('path');
const { getTenantDb } = require('../tenantDb');

const ATTACHMENT_COLLECTION = 'attachments';
const actor = (req) => req.headers['x-user-name'] || 'Owner';

// Which in-memory store array a given refType's records live in.
const REF_COLLECTION = {
  PURCHASE: 'purchases',
  PURCHASE_ORDER: 'purchaseOrders',
  VENDOR_CREDIT: 'vendorCredits'
};

exports.ATTACHMENT_COLLECTION = ATTACHMENT_COLLECTION;

exports.uploadAttachment = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }
    const { refType, refId } = req.body;
    const arrKey = REF_COLLECTION[refType];
    if (!arrKey || !refId) {
      return res.status(400).json({ success: false, message: 'A valid refType (PURCHASE, PURCHASE_ORDER, VENDOR_CREDIT) and refId are required.' });
    }

    const store = req.tenantStore;
    const record = (store?.[arrKey] || []).find((r) => r.id === refId);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Record not found.' });
    }

    const db = getTenantDb(req.tenantDbName);
    if (!db) {
      return res.status(503).json({
        success: false,
        code: 'TENANT_DB_UNAVAILABLE',
        message: 'Could not reach your shop database. Please try again in a moment.'
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.bin';
    const cleanName = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    const filename = `att_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${cleanName}${ext}`;

    await db.collection(ATTACHMENT_COLLECTION).insertOne({
      filename,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer,
      refType,
      refId,
      uploadedBy: actor(req),
      uploadedAt: new Date()
    });
    await db.collection(ATTACHMENT_COLLECTION).createIndex({ filename: 1 }, { unique: true }).catch(() => {});
    await db.collection(ATTACHMENT_COLLECTION).createIndex({ refType: 1, refId: 1 }).catch(() => {});

    const slug = req.tenant?.slug || String(req.tenantDbName).replace(/^tenant_db_/, '');
    const meta = {
      id: filename,
      filename,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      url: `/uploads/attachments/${slug}/${filename}`,
      uploadedBy: actor(req),
      uploadedAt: new Date().toISOString()
    };

    if (!Array.isArray(record.attachments)) record.attachments = [];
    record.attachments.push(meta);

    res.status(201).json({ success: true, message: 'File attached.', data: meta });
  } catch (err) {
    next(err);
  }
};

exports.deleteAttachment = async (req, res, next) => {
  try {
    const db = getTenantDb(req.tenantDbName);
    if (!db) {
      return res.status(503).json({
        success: false,
        code: 'TENANT_DB_UNAVAILABLE',
        message: 'Could not reach your shop database. Please try again in a moment.'
      });
    }

    const filename = path.basename(String(req.params.filename || ''));
    const result = await db.collection(ATTACHMENT_COLLECTION).deleteOne({ filename });
    if (!result.deletedCount) {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }

    const store = req.tenantStore;
    Object.values(REF_COLLECTION).forEach((arrKey) => {
      (store?.[arrKey] || []).forEach((r) => {
        if (Array.isArray(r.attachments)) r.attachments = r.attachments.filter((a) => a.filename !== filename);
      });
    });

    res.json({ success: true, message: 'Attachment deleted.' });
  } catch (err) {
    next(err);
  }
};
