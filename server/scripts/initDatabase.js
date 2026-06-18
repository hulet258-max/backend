const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Client } = require("pg");

const targetDatabase = process.env.PGDATABASE || "carta";

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function adminConfig(database) {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = `/${database}`;
    return {
      connectionString: url.toString(),
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
    };
  }

  return {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    database,
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
  };
}

async function ensureDatabase() {
  const client = new Client(adminConfig(process.env.PGADMIN_DATABASE || "postgres"));
  await client.connect();

  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [targetDatabase]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE ${quoteIdentifier(targetDatabase)}`);
    console.log(`Created database ${targetDatabase}`);
  } else {
    console.log(`Database ${targetDatabase} already exists`);
  }

  await client.end();
}

async function initializeSchema() {
  const client = new Client(adminConfig(targetDatabase));
  await client.connect();

  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "init.sql"), "utf8");
  await client.query(sql);
  await client.end();

  console.log(`Initialized schema for ${targetDatabase}`);
}

ensureDatabase()
  .then(initializeSchema)
  .catch((error) => {
    console.error("Postgres initialization failed:", error);
    process.exit(1);
  });
