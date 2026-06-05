import 'dotenv/config';
import { query } from '../db/client.js';

const HOURS = Number(process.argv[2] || 2);

async function main() {
  const { rows: agg } = await query(
    `select status, count(*)::int as n
       from activation_dispatch_events
      where category = 'processos-caa'
        and created_at >= now() - ($1 || ' hours')::interval
      group by status
      order by status`,
    [HOURS]
  );

  const { rows: timeline } = await query(
    `select created_at, count(*)::int as n,
            count(*) filter (where status = 'sent')      ::int as sent,
            count(*) filter (where status = 'not_found') ::int as not_found,
            count(*) filter (where status = 'failed')    ::int as failed
       from activation_dispatch_events
      where category = 'processos-caa'
        and created_at >= now() - ($1 || ' hours')::interval
      group by created_at
      order by created_at desc
      limit 80`,
    [HOURS]
  );

  const sorted = [...timeline].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const first = sorted[0]?.created_at;
  const last = sorted[sorted.length - 1]?.created_at;
  const durMs = first && last ? new Date(last).getTime() - new Date(first).getTime() : 0;

  console.log(`\n=== Disparos CAA nas últimas ${HOURS}h ===`);
  console.log('Por status:');
  for (const r of agg) console.log(`  ${r.status.padEnd(12)} ${r.n}`);
  if (sorted.length > 1) {
    console.log(`\nJanela do batch: ${first} → ${last}`);
    console.log(`Duração total:   ${(durMs / 1000).toFixed(1)}s (${(durMs / 60000).toFixed(2)}min)`);
    console.log(`Eventos:         ${sorted.length}`);
    console.log(`Taxa:            ${(sorted.length / (durMs / 1000 || 1)).toFixed(2)} disparos/s`);
  }

  const { rows: failedSamples } = await query(
    `select created_at, status, error_message, rgm, nome, telefone
       from activation_dispatch_events
      where category = 'processos-caa'
        and created_at >= now() - ($1 || ' hours')::interval
        and status in ('failed','not_found')
      order by created_at desc
      limit 10`,
    [HOURS]
  );
  if (failedSamples.length > 0) {
    console.log(`\nÚltimos failed/not_found (10):`);
    for (const r of failedSamples) {
      console.log(
        `  ${new Date(r.created_at).toISOString()} ${r.status.padEnd(10)} rgm=${(r.rgm || '-').padEnd(10)} ${r.nome || '-'} ${r.error_message ? `→ ${r.error_message}` : ''}`
      );
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('erro:', err);
  process.exit(1);
});
