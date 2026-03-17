const { Pool } = require("pg");

// 🔒 Log sécurisé (optionnel)
const dbUrl = process.env.DATABASE_URL;
if (dbUrl) {
  const safeUrl = dbUrl.replace(/:(.*?)@/, ":****@");
  console.log("DATABASE_URL (safe):", safeUrl);
}

// 🔗 Connexion PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// ❗ Gestion des erreurs
pool.on("error", (err) => {
  console.error("❌ PostgreSQL pool error:", err);
});

module.exports = pool;
