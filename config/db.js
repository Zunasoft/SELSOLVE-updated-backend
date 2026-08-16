const mongoose = require('mongoose');
const config = require('./config');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(config.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    console.log(`🍃 [MongoDB Connected] Host: ${conn.connection.host} | DB: ${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.warn(`⚠️ [MongoDB Connection Warning] ${error.message}`);
    console.warn('   Continuing with isolated multi-tenant dataset fallback.');
    return null;
  }
};

module.exports = connectDB;
