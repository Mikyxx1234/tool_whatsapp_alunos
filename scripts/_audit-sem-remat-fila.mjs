/**
 * Auditoria READ-ONLY rápida: Sem Rematrícula no espelho local vs relatório.
 * Uso: node scripts/_audit-sem-remat-fila.mjs
 * Sem escrita no CRM / sem listagem live.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, getPool } from '../server/db/client.js';
import { getNovoCrmStageIds, getNovoCrmDealFieldIds } from '../server/utils/novoCrmStageRules.js';
import { getIntersectionActivationList } from '../server/services/activationService.js';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import { normalizeCpf, normalizeRgm } from '../server/utils/novoCrmCacheNormalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'sem-remat-fila-audit.json');

function digits(v) {
  return String(v ?? '').replace(/\D+/g, '');
}

function addKeys(set, cpf, rgm) {
  const c = normalizeCpf(cpf) || (digits(cpf).length >= 11 ? digits(cpf).slice(-11) : '');
  const r = normalizeRgm(rgm) || '';
  if (c) set.add(`cpf:${c}`);
  if (r) set.add(`rgm:${r}`);
}

function inSet(set, cpf, rgm) {
  const c = normalizeCpf(cpf) || '';
  const r = normalizeRgm(rgm) || '';
  if (r && set.has(`rgm:${r}`)) return true;
  if (c && set.has(`cpf:${c}`)) return true;
  return false;
}

function personKey(cpf, rgm) {
  const r = normalizeRgm(rgm) || '';
  const c = normalizeCpf(cpf) || '';
  if (r) return `rgm:${r}`;
  if (c) return `cpf:${c}`;
  return null;
}

function fieldById(deal, fieldId) {
  if (!fieldId || !deal) return '';
  for (const f of deal.customFields || deal.custom_fields || []) {
    if (String(f.fieldId || f.field_id || '') === String(fieldId)) {
      return String(f.value ?? '').trim();
    }
  }
  return '';
}

function fieldByName(deal, names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of deal.customFields || deal.custom_fields || []) {
    const name = String(f?.name || '')
      .trim()
      .toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}

async function main() {
  const t0 = Date.now();
  const stages = getNovoCrmStageIds();
  const fields = getNovoCrmDealFieldIds();
  const stageId = String(stages['Sem Rematricula'] || '').trim();
  if (!stageId) throw new Error('stage Sem Rematricula vazio');

  const { rows: syncLog } = await query(
    `select id, mode, status, started_at, finished_at, contacts_seen, cache_upserted
     from novo_crm_cache_sync_log order by id desc limit 5`
  );

  // Contagem SQL direta (rápida)
  const { rows: cntRows } = await query(
    `select count(*)::int as n
     from novo_crm_person_cache c,
          lateral jsonb_each(coalesce(c.raw_data->'dealsById', '{}'::jsonb)) d
     where c.is_deleted = false
       and d.value->>'stageId' = $1`,
    [stageId]
  );
  const sqlCount = cntRows[0]?.n ?? 0;
  console.log(`SQL deals na etapa: ${sqlCount} (${Date.now() - t0}ms)`);

  // Carrega só deals da etapa via SQL (evita puxar cache inteiro)
  console.log('Extraindo deals da etapa...');
  const { rows: dealRows } = await query(
    `select c.contact_id, c.cpf_norm, c.rgm_norm, c.nome,
            d.key as deal_id, d.value as deal
     from novo_crm_person_cache c,
          lateral jsonb_each(coalesce(c.raw_data->'dealsById', '{}'::jsonb)) d
     where c.is_deleted = false
       and d.value->>'stageId' = $1`,
    [stageId]
  );

  const seen = new Set();
  const deals = [];
  for (const row of dealRows) {
    const dealId = String(row.deal_id);
    if (seen.has(dealId)) continue;
    seen.add(dealId);
    const deal = row.deal || {};
    const cpf =
      normalizeCpf(fieldById(deal, fields.cpf)) ||
      normalizeCpf(fieldByName(deal, ['cpf', 'CPF'])) ||
      normalizeCpf(row.cpf_norm) ||
      '';
    const rgm =
      normalizeRgm(fieldById(deal, fields.rgm)) ||
      normalizeRgm(fieldByName(deal, ['rgm', 'RGM'])) ||
      normalizeRgm(row.rgm_norm) ||
      '';
    deals.push({
      dealId,
      nome: deal.title || row.nome || '',
      cpf,
      rgm,
      ownerId: deal.ownerId || deal.owner_id || null,
    });
  }
  console.log(`Deals únicos: ${deals.length} (${Date.now() - t0}ms)`);

  // Att set = loadIdSetFromBase (todas as linhas)
  const rematMeta = await baseUploadRepo.getLatestSnapshot('rematricula');
  const attSet = new Set();
  let rematRows = 0;
  if (rematMeta?.id) {
    await baseUploadRepo.forEachRowDataForSnapshot('rematricula', rematMeta.id, (row) => {
      rematRows += 1;
      const cpf = digits(row.CPF || row.cpf || row.Cpf);
      const rgm = digits(row.RGM || row.rgm || row.Rgm);
      if (cpf.length >= 11) attSet.add(`cpf:${cpf.length === 11 ? cpf : cpf.padStart(11, '0').slice(-11)}`);
      else if (cpf.length >= 9) attSet.add(`cpf:${cpf.padStart(11, '0')}`);
      if (rgm) attSet.add(`rgm:${rgm}`);
    });
  }
  console.log(`Snapshot remat: ${rematRows} linhas, ${attSet.size} chaves Att (${Date.now() - t0}ms)`);

  // Relatório = roster rematricula (EM CURSO + master_key)
  console.log('Roster relatório...');
  const report = await getIntersectionActivationList('rematricula', { excludeDispatched: false });
  const reportItems = Array.isArray(report?.items) ? report.items : Array.isArray(report) ? report : [];
  const reportSet = new Set();
  let adimplente = 0;
  let inadimplente = 0;
  for (const it of reportItems) {
    addKeys(reportSet, it.cpf, it.rgm);
    if (String(it.remat_subgrupo || '').toLowerCase() === 'inadimplente') inadimplente += 1;
    else adimplente += 1;
  }
  console.log(`Relatório: ${reportItems.length} itens (${Date.now() - t0}ms)`);

  const personCount = new Map();
  let semIdentidade = 0;
  let inReport = 0;
  let inAttOnly = 0;
  let notInSnap = 0;
  const peopleReport = new Set();
  const peopleAttOnly = new Set();
  const peopleOut = new Set();

  for (const d of deals) {
    const pk = personKey(d.cpf, d.rgm);
    if (!pk) {
      semIdentidade += 1;
      continue;
    }
    personCount.set(pk, (personCount.get(pk) || 0) + 1);
    if (inSet(reportSet, d.cpf, d.rgm)) {
      inReport += 1;
      peopleReport.add(pk);
    } else if (inSet(attSet, d.cpf, d.rgm)) {
      inAttOnly += 1;
      peopleAttOnly.add(pk);
    } else {
      notInSnap += 1;
      peopleOut.add(pk);
    }
  }

  let multiPeople = 0;
  let extraDeals = 0;
  for (const n of personCount.values()) {
    if (n > 1) {
      multiPeople += 1;
      extraDeals += n - 1;
    }
  }

  const total = deals.length;
  const A1 = peopleReport.size;
  const A2 = inReport - A1;
  const A3 = peopleOut.size;
  const A4 = notInSnap - A3;
  const A5 = semIdentidade;
  const A6 = inAttOnly;
  const check = inReport + inAttOnly + notInSnap + semIdentidade;

  // Quantos do relatório NÃO têm deal na etapa
  let reportMissingStage = 0;
  for (const it of reportItems) {
    if (!inSet(
      new Set(
        [...peopleReport].flatMap((pk) => {
          // cheaper: rebuild deal identity set
          return [];
        })
      ),
      it.cpf,
      it.rgm
    )) {
      // use reportSet vs deals instead
    }
  }
  const dealIdSet = new Set();
  for (const d of deals) {
    if (d.rgm) dealIdSet.add(`rgm:${d.rgm}`);
    if (d.cpf) dealIdSet.add(`cpf:${d.cpf}`);
  }
  for (const it of reportItems) {
    if (!inSet(dealIdSet, it.cpf, it.rgm)) reportMissingStage += 1;
  }

  const out = {
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    read_only: true,
    fonte: 'novo_crm_person_cache (Postgres local) — zero API live',
    stage: { name: 'Sem Rematricula', stageId },
    sync_log_recente: syncLog,
    sql_count_deals_etapa: sqlCount,
    snapshots: {
      rematricula: rematMeta
        ? {
            id: rematMeta.id,
            file_name: rematMeta.file_name,
            source: rematMeta.source,
            row_count: rematMeta.row_count,
            created_at: rematMeta.created_at,
            rows_lidas: rematRows,
          }
        : null,
    },
    conjuntos: {
      att_chaves: attSet.size,
      relatorio_itens: reportItems.length,
      relatorio_chaves: reportSet.size,
      relatorio_adimplente: adimplente,
      relatorio_inadimplente: inadimplente,
    },
    deals: {
      total_na_etapa_cache: total,
      com_identidade: total - semIdentidade,
      sem_identidade: semIdentidade,
      pessoas_distintas: personCount.size,
      pessoas_com_multiplos_deals: multiPeople,
      deals_extra_multi_deal: extraDeals,
    },
    buckets: {
      in_report_deals: inReport,
      in_report_pessoas: peopleReport.size,
      in_att_only_deals: inAttOnly,
      in_att_only_pessoas: peopleAttOnly.size,
      not_in_snapshot_deals: notInSnap,
      not_in_snapshot_pessoas: peopleOut.size,
      sem_identidade: semIdentidade,
      relatorio_itens_sem_deal_na_etapa: reportMissingStage,
    },
    decomposicao: {
      A_kanban_cache_deals: total,
      B_relatorio_pessoas: reportItems.length,
      A1_pessoas_do_relatorio_com_deal: A1,
      A2_deals_extra_multi_deal: A2,
      A3_pessoas_fora_do_snapshot: A3,
      A4_deals_extra_fora_do_snapshot: A4,
      A5_deals_sem_cpf_rgm: A5,
      A6_deals_att_fora_do_relatorio: A6,
      check_soma: check,
      check_diff: total - check,
      delta_kanban_menos_relatorio: total - reportItems.length,
    },
    criterio_relatorio:
      '_buildRematriculaList: isRematriculaEmCursoRow(row) + dedupe masterKeyFromActivationItem (RGM>CPF>phone>email) + remat_subgrupo. SIAA zip já filtra SIT_ATUAL=EM CURSO no import.',
    recomendacao: {
      filtrar_em_curso_em_loadIdSetFromBase:
        A6 === 0
          ? 'NÃO resolve o delta: att_only=0 (snapshot SIAA já é só EM CURSO).'
          : `Há ${A6} deals no Att fora do relatório — filtro ajudaria parcialmente.`,
      causa_principal:
        'Kanban=DEALS vs Relatório=PESSOAS. Delta ≈ multi-deal + sem CPF/RGM + fora do snapshot + pessoas do relatório ainda fora da etapa.',
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // Sobrescreve o JSON gigante anterior por um resumo leve
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`\nSalvo ${OUT} em ${Date.now() - t0}ms`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => getPool().end().catch(() => {}));
