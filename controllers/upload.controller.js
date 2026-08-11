/**
 * Upload Controller
 * Business logic for file upload and deletion.
 */

const fs = require('fs');
const path = require('path');

const uploadDir = path.join(__dirname, '../uploads/products');

exports.uploadImage = (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image file uploaded.' });
  }

  const relativeUrl = `/uploads/products/${req.file.filename}`;
  res.json({
    success: true,
    message: 'Image uploaded successfully.',
    url: relativeUrl,
    filename: req.file.filename,
    size: req.file.size
  });
};

exports.deleteImage = (req, res) => {
  const filePath = path.join(uploadDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return res.json({ success: true, message: 'Image deleted.' });
  }
  res.status(404).json({ success: false, message: 'File not found.' });
};
