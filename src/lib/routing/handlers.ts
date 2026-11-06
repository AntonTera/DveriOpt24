import { AMO_STATUS, EXCLUDED_RESPONSIBLE_USER_ID, MAIN_PIPELINE_ID } from "@/lib/constants/amocrm";
import { formatDisplayDate } from "@/lib/utils/datetime";
import type { RoutingCrm, RoutingLead, RoutingTask } from "./crm";
import type { RoutingChannel, RoutingEvent } from "./ingress";
import type { CloseDateJob } from "./close-date";

export const FORMER_DUTY_OWNER_ID = 12043998;
export const MAX_SHIFT_PAGES = 100;
const PERSONAL_TAG_ID = 321809;
const PERSONAL_TAG = "\u043b\u0438\u0447\u043d\u0430\u044f \u0441\u0434\u0435\u043b\u043a\u0430";
const COMMISSION_TASK = "\u041e\u0442\u043a\u043e\u0441\u044b: \u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u043a\u043e\u043c\u0438\u0441\u0441\u0438\u044e, \u0437\u0430\u043a\u0440\u044b\u0442\u044c \u0441\u0434\u0435\u043b\u043a\u0443.";
const REPLY_TASK: Record<RoutingChannel, string> = {
  vk: "\u041e\u0442\u0432\u0435\u0442\u0438\u0442\u044c \u043d\u0430 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u0432 VK",
  telegram: "\u041e\u0442\u0432\u0435\u0442\u0438\u0442\u044c \u043d\u0430 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u0432 Telegram \u0431\u043e\u0442\u0435",
  wazzup: "\u041e\u0442\u0432\u0435\u0442\u0438\u0442\u044c \u043d\u0430 \u0412\u0430\u0442\u0441\u0430\u043f \u043f\u043e \u0437\u0430\u043a\u0440\u044b\u0442\u043e\u0439 \u0441\u0434\u0435\u043b\u043a\u0435"
};
const CLOSED_STATUSES = new Set<number>([AMO_STATUS.COMMISSION_RECEIVED, AMO_STATUS.REFUSED]);
const SHIFT_STATUSES = Object.values(AMO_STATUS).filter((status) => !CLOSED_STATUSES.has(status));

export type RoutingWork = RoutingEvent |
  { kind: "shift-scan"; day: string; page: number; ownerId?: number } |
  { kind: "shift-lead"; day: string; leadId: number; ownerId: number };

export type RoutingEnqueueJob = { dedupe_key: string; payload: RoutingWork | CloseDateJob; next_run_at: string };
type ReadCrm = Pick<RoutingCrm, "getLead" | "listLeadTasks" | "getContact" | "listShiftLeads">;
type ShiftReads = {
  crm: ReadCrm;
  dutyOwnerIds: readonly number[];
  getDutyOwner: () => Promise<number | null>;
};
export type RoutingDependencies = ShiftReads & {
  crm: RoutingCrm;
  now: Date;
  enqueue: (jobs: RoutingEnqueueJob[]) => Promise<void>;
  beforeCreateReply: () => Promise<void>;
  assertRunning: () => void;
};

type RoutingResult = { status: "processed" | "skipped" | "needs_review"; reason?: string; queued?: number };
type ShiftAction = { leadId: number; changeLeadOwner: boolean; taskIds: number[]; contactId: number | null };
const processed = { status: "processed" } as const;
const skip = (reason: string): RoutingResult => ({ status: "skipped", reason });

function protectsLead(lead: RoutingLead) {
  return lead.ownerId === EXCLUDED_RESPONSIBLE_USER_ID ||
    lead.tags.some(({ id, name }) => id === PERSONAL_TAG_ID || name?.trim().toLowerCase().replace(/\s+/gu, " ") === PERSONAL_TAG);
}

function sourceOwners(deps: ShiftReads) {
  return [FORMER_DUTY_OWNER_ID, ...deps.dutyOwnerIds];
}

function isDutySource(ownerId: number | null, deps: ShiftReads) {
  return ownerId !== null && sourceOwners(deps).includes(ownerId);
}

function isOpenLeadTask(task: RoutingTask, leadId: number) {
  return !task.completed && task.entityType === "leads" && task.entityId === leadId;
}

function eligibleTask(task: RoutingTask, leadId: number, deps: ShiftReads) {
  return isOpenLeadTask(task, leadId) && isDutySource(task.ownerId, deps) && task.text !== COMMISSION_TASK;
}

function eligibleShiftLead(lead: RoutingLead, deps: ShiftReads) {
  return lead.pipelineId === MAIN_PIPELINE_ID &&
    SHIFT_STATUSES.some((status) => status === lead.statusId) &&
    isDutySource(lead.ownerId, deps) && !protectsLead(lead);
}

async function shiftAction(lead: RoutingLead, ownerId: number, deps: ShiftReads): Promise<ShiftAction> {
  const tasks = await deps.crm.listLeadTasks(lead.id);
  const taskIds = tasks.filter((task) => eligibleTask(task, lead.id, deps) && task.ownerId !== ownerId).map(({ id }) => id);
  const firstContact = lead.contactIds[0];
  const contact = firstContact ? await deps.crm.getContact(firstContact) : null;
  const contactId = contact && contact.leadIds?.length === 1 && contact.leadIds[0] === lead.id &&
    contact.ownerId !== ownerId && isDutySource(contact.ownerId, deps) ? contact.id : null;
  return { leadId: lead.id, changeLeadOwner: lead.ownerId !== ownerId, taskIds, contactId };
}

export async function previewRoutingShift(deps: ShiftReads, page: number) {
  const ownerId = await deps.getDutyOwner();
  const actions: ShiftAction[] = [];
  if (!ownerId) return { ownerId, page, actions, hasNext: false };
  const { leads, hasNext } = await deps.crm.listShiftLeads(sourceOwners(deps), SHIFT_STATUSES, page, 10);
  for (const candidate of leads.filter((lead) => eligibleShiftLead(lead, deps))) {
    const lead = await deps.crm.getLead(candidate.id);
    if (!lead || !eligibleShiftLead(lead, deps)) continue;
    const action = await shiftAction(lead, ownerId, deps);
    if (action.changeLeadOwner || action.taskIds.length || action.contactId) actions.push(action);
  }
  return { ownerId, page, actions, hasNext };
}

export async function handleRoutingWork(work: RoutingWork, deps: RoutingDependencies): Promise<RoutingResult> {
  const { crm, assertRunning } = deps;
  if (work.kind === "lead") {
    const ownerId = await deps.getDutyOwner();
    if (!ownerId) return skip("no_duty_owner");
    const lead = await crm.getLead(work.leadId);
    if (!lead || lead.pipelineId !== MAIN_PIPELINE_ID || lead.statusId !== AMO_STATUS.NEW ||
        protectsLead(lead) || (lead.ownerId !== null && lead.ownerId !== 0 && !isDutySource(lead.ownerId, deps))) {
      return skip("lead_outside_scope");
    }
    const task = (await crm.listLeadTasks(lead.id)).filter((item) => eligibleTask(item, lead.id, deps))
      .sort((a, b) => a.id - b.id)[0];
    if (lead.ownerId !== ownerId) {
      assertRunning();
      await crm.setLeadOwner(lead.id, ownerId);
    }
    if (task && task.ownerId !== ownerId) {
      assertRunning();
      await crm.setTaskOwners([task.id], ownerId);
    }
    return processed;
  }

  if (work.kind === "task") {
    const ownerId = await deps.getDutyOwner();
    if (!ownerId) return skip("no_duty_owner");
    const task = await crm.getTask(work.taskId);
    if (!task?.entityId || !eligibleTask(task, task.entityId, deps)) return skip("task_outside_scope");
    const lead = await crm.getLead(task.entityId);
    if (!lead || lead.pipelineId !== MAIN_PIPELINE_ID || protectsLead(lead) || !isDutySource(lead.ownerId, deps)) {
      return skip("lead_outside_scope");
    }
    if (task.ownerId !== ownerId) {
      assertRunning();
      await crm.setTaskOwners([task.id], ownerId);
    }
    return processed;
  }

  if (work.kind === "message") {
    const lead = await crm.getLead(work.leadId);
    if (!lead || lead.pipelineId !== MAIN_PIPELINE_ID ||
        (work.channel === "wazzup" && !CLOSED_STATUSES.has(lead.statusId))) return skip("lead_outside_scope");
    const protectedLead = protectsLead(lead);
    if (!protectedLead && !isDutySource(lead.ownerId, deps)) return skip("lead_outside_scope");
    const ownerId = protectedLead
      ? lead.ownerId && await crm.isUserActive(lead.ownerId) ? lead.ownerId : null
      : await deps.getDutyOwner();
    if (!ownerId) return skip("no_active_owner");
    const text = REPLY_TASK[work.channel];
    const openReply = (await crm.listLeadTasks(lead.id)).some((task) => isOpenLeadTask(task, lead.id) && task.text === text);
    if (!protectedLead && lead.ownerId !== ownerId) {
      assertRunning();
      await crm.setLeadOwner(lead.id, ownerId);
    }
    if (openReply) return skip("reply_already_open");

    assertRunning();
    await deps.beforeCreateReply();
    try {
      assertRunning();
      await crm.createReplyTask(lead.id, ownerId, text, Math.floor(deps.now.getTime() / 1000));
      return processed;
    } catch {
      return { status: "needs_review", reason: "reply_creation_unconfirmed" };
    }
  }

  if (work.day !== formatDisplayDate(deps.now)) return skip("shift_date_changed");
  const ownerId = await deps.getDutyOwner();
  if (!ownerId || (work.ownerId !== undefined && work.ownerId !== ownerId)) return skip("shift_owner_changed_or_missing");

  if (work.kind === "shift-scan") {
    const { leads, hasNext } = await crm.listShiftLeads(sourceOwners(deps), SHIFT_STATUSES, work.page, 50);
    const jobs = leads.filter((lead) => eligibleShiftLead(lead, deps)).map((lead): RoutingEnqueueJob => ({
      dedupe_key: `shift:${work.day}:lead:${lead.id}`,
      payload: { kind: "shift-lead", day: work.day, leadId: lead.id, ownerId },
      next_run_at: deps.now.toISOString()
    }));
    if (hasNext && work.page < MAX_SHIFT_PAGES) {
      const page = work.page + 1;
      jobs.push({
        dedupe_key: `shift:${work.day}:scan:${page}`,
        payload: { kind: "shift-scan", day: work.day, page, ownerId },
        next_run_at: deps.now.toISOString()
      });
    }
    if (jobs.length) {
      assertRunning();
      await deps.enqueue(jobs);
    }
    return hasNext && work.page >= MAX_SHIFT_PAGES
      ? { status: "needs_review", reason: "shift_pagination_limit", queued: jobs.length }
      : { status: "processed", queued: jobs.length };
  }

  const lead = await crm.getLead(work.leadId);
  if (!lead || !eligibleShiftLead(lead, deps)) return skip("lead_outside_scope");
  const action = await shiftAction(lead, ownerId, deps);
  if (action.changeLeadOwner) {
    assertRunning();
    await crm.setLeadOwner(lead.id, ownerId);
  }
  for (let i = 0; i < action.taskIds.length; i += 50) {
    assertRunning();
    await crm.setTaskOwners(action.taskIds.slice(i, i + 50), ownerId);
  }
  if (action.contactId) {
    assertRunning();
    await crm.setContactOwner(action.contactId, ownerId);
  }
  return processed;
}
