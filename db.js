// Base de datos SQLite (incluida en Node 22+). Un solo archivo: data/iac.db
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'iac.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('comprador','vendedor','ambos')),
  logo TEXT, color TEXT DEFAULT '#1f4fd1',
  tax_id TEXT, address TEXT, phone TEXT, web TEXT,
  plan TEXT, plan_status TEXT DEFAULT 'trial', plan_until INTEGER,
  stripe_customer TEXT, stripe_subscription TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL, name TEXT, pass TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0, is_super INTEGER DEFAULT 0, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sku TEXT, name TEXT NOT NULL, unit TEXT DEFAULT 'ud',
  list_price REAL NOT NULL, min_price REAL NOT NULL, cost REAL DEFAULT 0,
  stock INTEGER DEFAULT 0, lead_days INTEGER DEFAULT 3, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS policies (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('compra','venta')),
  json TEXT NOT NULL, PRIMARY KEY (company_id, side)
);
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pendiente', message TEXT, created INTEGER NOT NULL,
  UNIQUE (seller_id, buyer_id)
);
CREATE TABLE IF NOT EXISTS needs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL, qty INTEGER NOT NULL,
  target_price REAL NOT NULL, max_price REAL NOT NULL, max_days INTEGER NOT NULL,
  consumption INTEGER, forecast INTEGER, buyer_stock INTEGER,
  status TEXT DEFAULT 'abierta', created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  need_id INTEGER NOT NULL REFERENCES needs(id) ON DELETE CASCADE,
  seller_id INTEGER NOT NULL, buyer_id INTEGER NOT NULL, product_id INTEGER,
  status TEXT NOT NULL, motivo TEXT,
  price REAL, qty INTEGER, total REAL, lead_days INTEGER, partial INTEGER DEFAULT 0,
  score REAL, chosen INTEGER DEFAULT 0,
  need_buyer_ok INTEGER DEFAULT 1, need_seller_ok INTEGER DEFAULT 1,
  buyer_ok INTEGER DEFAULT 0, seller_ok INTEGER DEFAULT 0,
  log TEXT, created INTEGER NOT NULL, closed INTEGER
);
`);

const now = () => Date.now();
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

const DEFAULT_POLICY = {
  venta: {
    mostrar: { catalogo: true, stock: true, plazo: true, costes: false },
    cierre: { modo: 'auto', descuento_max_auto: 8, importe_max_auto: 5000 },
    prioridades: { margen: 50, volumen: 30, rotacion: 20 },
    estilo: 'equilibrado', margen_min_pct: 10, instrucciones: ''
  },
  compra: {
    compartir: { consumo: true, prevision: true, stock: false },
    cierre: { modo: 'auto', importe_max_auto: 3000 },
    prioridades: { precio: 60, plazo: 25, fiabilidad: 15 },
    estilo: 'equilibrado', acepta_parciales: true, instrucciones: ''
  }
};

function getPolicy(companyId, side) {
  const r = one('SELECT json FROM policies WHERE company_id=? AND side=?', companyId, side);
  const base = structuredClone(DEFAULT_POLICY[side]);
  if (!r) return base;
  const saved = JSON.parse(r.json);
  for (const k of Object.keys(base)) {
    if (saved[k] === undefined) continue;
    base[k] = (typeof base[k] === 'object' && base[k] !== null) ? { ...base[k], ...saved[k] } : saved[k];
  }
  return base;
}
function setPolicy(companyId, side, policy) {
  run('INSERT INTO policies (company_id, side, json) VALUES (?,?,?) ON CONFLICT(company_id, side) DO UPDATE SET json=excluded.json',
    companyId, side, JSON.stringify(policy));
}

module.exports = { db, one, all, run, now, getPolicy, setPolicy, DEFAULT_POLICY };
