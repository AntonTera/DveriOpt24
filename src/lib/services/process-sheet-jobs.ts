import { findSheetRowByDealAndKpi, appendSheetRow, updateSheetRow } from "@/lib/google/sheets";
import {
  markSheetJobFailed,
  markSheetJobProcessed,
  updateDealStateSheetPointer
} from "@/lib/repositories";
import { SheetJobRecord, SheetName } from "@/lib/types";
import { sleep } from "@/lib/utils/sleep";

async function resolveRowIndex(job: SheetJobRecord): Promise<number | null> {
  if (job.payload.rowIndex) {
    return job.payload.rowIndex;
  }

  return findSheetRowByDealAndKpi(job.sheet_name, job.deal_id, job.payload.row.kpiLabel);
}

export async function processSheetJob(job: SheetJobRecord) {
  const rowIndex = await resolveRowIndex(job);

  let finalRowIndex = rowIndex;
  if (finalRowIndex) {
    await updateSheetRow(job.sheet_name as SheetName, finalRowIndex, job.payload.row);
  } else {
    finalRowIndex = await appendSheetRow(job.sheet_name as SheetName, job.payload.row);
  }

  await updateDealStateSheetPointer(
    job.deal_id,
    job.sheet_name === "KP new" ? "kp_rows" : "zp_rows",
    job.payload.stage,
    {
      rowIndex: finalRowIndex,
      payload: job.payload.row
    }
  );

  await markSheetJobProcessed(job.id);
}

export async function safelyProcessSheetJob(job: SheetJobRecord) {
  try {
    await processSheetJob(job);
    await sleep(300);
  } catch (error) {
    await markSheetJobFailed(
      job.id,
      job.attempts,
      error instanceof Error ? error.message : "Unknown sheet processing error"
    );
  }
}
