/**
 * Upload Controller — product images live in the shop's own database.
 *
 * Images are stored as documents in the tenant's `productimages` collection and
 * served back by `GET /uploads/products/:slug/:filename`. That URL has to work
 * from a plain `<img src>`, which cannot carry an Authorization header, so the
 * filename carries the entropy: it is unguessable, exactly as the previous
 * publicly-served upload directory was.
 */

const crypto = require('crypto');
const path = require('path');
const { getTenantDb } = require('../tenantDb');

const IMAGE_COLLECTION = 'productimages';

exports.IMAGE_COLLECTION = IMAGE_COLLECTION;

exports.uploadImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file uploaded.' });
    }

    const db = getTenantDb(req.tenantDbName);
    if (!db) {
      return res.status(503).json({
        success: false,
        code: 'TENANT_DB_UNAVAILABLE',
        message: 'Could not reach your shop database. Please try again in a moment.'
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
    const cleanName = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    const filename = `prod_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${cleanName}${ext}`;

    await db.collection(IMAGE_COLLECTION).insertOne({
      filename,
      contentType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer,
      uploadedAt: new Date()
    });

    await db.collection(IMAGE_COLLECTION).createIndex({ filename: 1 }, { unique: true }).catch(() => {});

    const slug = req.tenant?.slug || String(req.tenantDbName).replace(/^tenant_db_/, '');

    res.json({
      success: true,
      message: 'Image uploaded successfully.',
      url: `/uploads/products/${slug}/${filename}`,
      filename,
      size: req.file.size
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteImage = async (req, res, next) => {
  try {
    const db = getTenantDb(req.tenantDbName);
    if (!db) {
      return res.status(503).json({
        success: false,
        code: 'TENANT_DB_UNAVAILABLE',
        message: 'Could not reach your shop database. Please try again in a moment.'
      });
    }

    // Only the basename is used, so a path cannot be walked out of the shop.
    const filename = path.basename(String(req.params.filename || ''));
    const result = await db.collection(IMAGE_COLLECTION).deleteOne({ filename });

    if (!result.deletedCount) {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }

    res.json({ success: true, message: 'Image deleted.' });
  } catch (err) {
    next(err);
  }
};
