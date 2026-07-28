import "dotenv/config";
import fs from "node:fs";
process.env.NOVO_CRM_PROVISION_ALLOW_PROD = "1";
process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS = process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS || "60";

const logPath = `data/apply-orphan-retry-${Date.now()}.log`;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  fs.appendFileSync(logPath, line + "\n");
}

const { isNovoCrmWriteAllowedOnThisHost } = await import("../server/services/novoCrmMatriculadosProvisionService.js");
const { runOrphanAlunoProvision } = await import("../server/services/novoCrmOrphanAlunoProvisionService.js");

log("CRM", process.env.NOVO_CRM_API_BASE_URL);
log("writeAllowed", isNovoCrmWriteAllowedOnThisHost());
if (!isNovoCrmWriteAllowedOnThisHost()) { log("ABORT"); process.exit(1); }

log("ORPHAN RETRY START (fixed stage ids)");
const orphan = await runOrphanAlunoProvision({ dryRun: false, maxCreates: 20000 });
const { samples, error_samples, ...orphanSummary } = orphan;
log("ORPHAN RETRY DONE", JSON.stringify(orphanSummary));
fs.writeFileSync(logPath.replace(".log", "-full.json"), JSON.stringify(orphan, null, 2));
if (error_samples?.length) log("orphan errors sample", JSON.stringify(error_samples.slice(0, 10)));
log("DONE", logPath);
