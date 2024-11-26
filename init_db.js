// init_db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query(
  `CREATE TABLE IF NOT EXISTS insights (
    id SERIAL PRIMARY KEY,
    job_id VARCHAR(255) UNIQUE NOT NULL,
    persona VARCHAR(50) NOT NULL,
    insights TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  (err, res) => {
    if (err) {
      console.error('Error creating table', err.stack);
    } else {
      console.log('Table is ready');
      pool.end();
    }
  }
);
