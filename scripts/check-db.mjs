import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const t = await c.query(
  "select tablename from pg_tables where schemaname='public' order by tablename"
);
console.log('TABLES:');
t.rows.forEach((r) => console.log(' -', r.tablename));

const v = await c.query(
  "select viewname from pg_views where schemaname='public' order by viewname"
);
console.log('VIEWS:');
v.rows.forEach((r) => console.log(' -', r.viewname));

const tr = await c.query(
  "select tgname from pg_trigger where not tgisinternal order by tgname"
);
console.log('TRIGGERS:');
tr.rows.forEach((r) => console.log(' -', r.tgname));

const ct = await c.query('select code, name from campaign_types order by name');
console.log('CAMPAIGN TYPES:');
ct.rows.forEach((r) => console.log(' -', r.code, '|', r.name));

await c.end();
