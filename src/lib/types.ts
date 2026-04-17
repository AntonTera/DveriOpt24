export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type KpiStage = "work" | "measure" | "install";
export type SheetName = "KP new" | "ЗП new";

export interface LeadChangeEvent {
  id?: string;
  lead_id: number;
  pipeline_id: number | null;
  status_id: number | null;
  event_type: string;
  received_at: string;
  payload_hash: string;
  raw_payload: JsonValue;
}

export interface AmoLeadSnapshot {
  id: number;
  name: string;
  pipelineId: number;
  statusId: number;
  responsibleUserId: number | null;
  objectType: string | null;
  link: string;
}

export interface ActiveKpiRecord {
  stage: KpiStage;
  label: string;
  amount: number;
  date: string;
  time: string;
  manager: string;
}

export interface SheetRowPayload {
  stage: KpiStage;
  date: string;
  time: string | null;
  kpiLabel: string;
  leadName: string;
  amount: number;
  link: string;
  dealId: number;
  installDate: string | null;
}

export interface SheetRowPointer {
  rowIndex: number | null;
  payload: SheetRowPayload;
}

export interface StoredDealState {
  deal_id: number;
  object_type: string | null;
  is_frozen: boolean;
  active_kpis: Partial<Record<KpiStage, ActiveKpiRecord>>;
  kp_rows: Partial<Record<KpiStage, SheetRowPointer>>;
  zp_rows: Partial<Record<KpiStage, SheetRowPointer>>;
  last_status_id: number | null;
  last_synced_at: string | null;
}

export interface AmoFieldMutation {
  fieldId: number;
  value: string | number;
}

export interface LeadKpiState {
  dealId: number;
  objectType: string | null;
  isFrozen: boolean;
  activeKpis: Partial<Record<KpiStage, ActiveKpiRecord>>;
  amoFieldsPatch: AmoFieldMutation[];
  sheetRowsKpNew: SheetRowPayload[];
  sheetRowsZpNew: SheetRowPayload[];
}

export interface SheetJobPayload {
  stage: KpiStage;
  rowIndex: number | null;
  row: SheetRowPayload;
}

export interface SheetJobRecord {
  id: string;
  deal_id: number;
  sheet_name: SheetName;
  job_type: string;
  row_key: string;
  payload: SheetJobPayload;
  status: string;
  attempts: number;
  next_run_at: string | null;
  last_error: string | null;
}

export interface WebhookEventRecord extends LeadChangeEvent {
  id: string;
  processing_status: string;
  process_attempts: number;
  last_error: string | null;
}
