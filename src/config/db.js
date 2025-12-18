const mongoose = require('mongoose');
const dns = require('node:dns');

const { formatErrorForLog } = require('../services/utils/safeError');

let connected = false;
let listenersAttached = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertMongoUri(uri) {
  if (!uri || typeof uri !== 'string') {
    throw new Error('Missing MongoDB connection string (MONGODB_URI).');
  }
  if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
    throw new Error(
      'Invalid MongoDB connection string: expected mongodb:// or mongodb+srv://'
    );
  }
}

async function connectToMongo(uri) {
  if (mongoose.connection.readyState === 1) {
    connected = true;
    return mongoose.connection;
  }
  if (connected) return mongoose.connection;

  assertMongoUri(uri);

  // Helps on some Windows + IPv6/DNS setups where Atlas SRV lookups
  // may resolve to unreachable addresses.
  dns.setDefaultResultOrder('ipv4first');

  mongoose.set('strictQuery', true);

  if (!listenersAttached) {
    listenersAttached = true;

    mongoose.connection.on('connected', () => {
      connected = true;
    });
    mongoose.connection.on('disconnected', () => {
      connected = false;
      console.warn('MongoDB disconnected. Will retry on next operation.');
    });
    mongoose.connection.on('error', (err) => {
      console.error('MongoDB connection error:', formatErrorForLog(err));
    });
  }

  const maxAttempts = Number.parseInt(process.env.MONGODB_CONNECT_RETRIES || '5', 10);
  const baseDelayMs = Number.parseInt(process.env.MONGODB_CONNECT_RETRY_DELAY_MS || '1500', 10);

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: Number.parseInt(
          process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || '10000',
          10
        ),
        connectTimeoutMS: Number.parseInt(
          process.env.MONGODB_CONNECT_TIMEOUT_MS || '10000',
          10
        ),
        // Prefer IPv4 when the underlying driver supports it.
        family: 4,
      });

      connected = true;
      console.log('Connected to MongoDB');
      return mongoose.connection;
    } catch (err) {
      lastErr = err;
      const waitMs = baseDelayMs * attempt;
      console.error(
        `MongoDB connection attempt ${attempt}/${maxAttempts} failed (${formatErrorForLog(err)}). Retrying in ${waitMs}ms...`
      );
      if (attempt < maxAttempts) {
        await sleep(waitMs);
      }
    }
  }

  if (lastErr && lastErr.name === 'MongooseServerSelectionError') {
    console.error(
      'MongoDB server selection failed. Common causes: Atlas IP whitelist not set, VPN/firewall blocking access, bad DNS/IPv6 routing, or incorrect credentials/URI.'
    );
  }

  throw lastErr;
}

module.exports = { connectToMongo };
