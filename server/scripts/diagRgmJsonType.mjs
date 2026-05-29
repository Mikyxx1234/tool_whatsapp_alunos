import 'dotenv/config';
import { query } from '../db/client.js';

const { rows } = await query(`
  select jsonb_typeof(data->'RGM') as t, data->'RGM' as v
  from financeiro_rows limit 8
`);
console.log(rows);

process.exit(0);
