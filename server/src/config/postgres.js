const { Pool } = require("pg");

const databaseUrl = process.env.DATABASE_URL;

const pool = new Pool(
  databaseUrl
    ? {
        connectionString: databaseUrl,
        ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
      }
    : {
        host: process.env.PGHOST || "127.0.0.1",
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE || "carta",
        user: process.env.PGUSER || "postgres",
        password: process.env.PGPASSWORD || "",
      }
);

pool.on("error", (err) => {
  console.error("Postgres pool error:", err);
});

async function testConnection() {
  await pool.query("SELECT 1");
  console.log("Postgres connected");
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  testConnection,
};
