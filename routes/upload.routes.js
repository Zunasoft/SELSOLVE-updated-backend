/**
 * Product image upload.
 *
 * The file is held in memory only long enough to be written into the calling
 * shop's own MongoDB database. Nothing is written to the server's filesystem:
 * on a serverless host that disk is read-only in places and thrown away between
 * invocations, so an uploaded image would disappear minutes after it was saved.
 */

const express = require('express');
const multer = require('multer');
const uploadController = require('../controllers/upload.controller');
const attachmentController = require('../controllers/attachment.controller');

const router = express.Router();

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, WEBP, GIF, and SVG images are allowed.'), false);
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

router.post('/upload', upload.single('image'), uploadController.uploadImage);
router.delete('/upload/:filename', uploadController.deleteImage);

// Generic record attachments (vendor invoice photo/PDF, delivery challan, etc.)
const attachmentFileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, WEBP, GIF, and PDF files are allowed.'), false);
  }
};

const uploadAttachment = multer({
  storage: multer.memoryStorage(),
  fileFilter: attachmentFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/attachments', uploadAttachment.single('file'), attachmentController.uploadAttachment);
router.delete('/attachments/:filename', attachmentController.deleteAttachment);

module.exports = router;
