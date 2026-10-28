const { MongoClient } = require('mongodb');

let client = null;
let db = null;

async function connectDB() {
  if (db) return db;

  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/oursocial';
  client = new MongoClient(uri);
  await client.connect();
  db = client.db();

  return db;
}

function getDB() {
  if (!db) throw new Error('DB not connected. Call connectDB() first.');
  return db;
}

module.exports = { connectDB, getDB };