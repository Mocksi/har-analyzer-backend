const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function cleanupExpiredInsights() {
  try {
    const result = await pool.query(
      'DELETE FROM insights WHERE expires_at < CURRENT_TIMESTAMP'
    );
    console.log(`Cleaned up ${result.rowCount} expired insights`);
  } catch (error) {
    console.error('Error cleaning up expired insights:', error);
  }
}

// Run cleanup every hour
setInterval(cleanupExpiredInsights, 60 * 60 * 1000);

module.exports = { cleanupExpiredInsights }; 