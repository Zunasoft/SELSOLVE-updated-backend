const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, message: `No route matches ${req.method} ${req.originalUrl}` });
};

const errorHandler = (err, req, res, next) => {
  console.error('[POS Backend Error]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error.'
  });
};

module.exports = { notFoundHandler, errorHandler };
