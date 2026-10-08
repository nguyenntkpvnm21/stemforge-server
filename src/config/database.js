const mongoose = require('mongoose');

async function connectDatabase() {
  const requiredVariables = [
    'MONGO_URI',
    'MONGO_USERNAME',
    'MONGO_PASSWORD',
  ];

  for (const variable of requiredVariables) {
    if (!process.env[variable]) {
      throw new Error(`Missing environment variable: ${variable}`);
    }
  }

  await mongoose.connect(process.env.MONGO_URI, {
    user: process.env.MONGO_USERNAME,
    pass: process.env.MONGO_PASSWORD,
  });

  console.log(`MongoDB connected: ${mongoose.connection.name}`);
}

mongoose.connection.on('error', (error) => {
  console.error('MongoDB connection error:', error.message);
});

module.exports = connectDatabase;