import { describe, expect, it, vi } from "vitest";
import { AMO_STATUS, MAIN_PIPELINE_ID } from "@/lib/constants/amocrm";
import { handleRoutingWork, previewRoutingShift, type RoutingDependencies } from "@/lib/routing/handlers";
import { type RoutingLead, type RoutingTask } from "@/lib/routing/crm";

const PHILIPP = 7268314;
const LYUDMILA = 12043998;
const ARTEM = 8445565;
const NOW = new Date("2026-11-05T00:00:30Z");
const DAY = "05.11.2026";
const replyText = "\u041e\u0442\u0432\u0435\u0442\u0438\u0442\u044c \u043d\u0430 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u0432 VK";

function lead(overrides: Partial<RoutingLead> = {}): RoutingLead {
  return { id: 10, pipelineId: MAIN_PIPELINE_ID, statusId: AMO_STATUS.NEW, ownerId: LYUDMILA, tags: [], contactIds: [30], ...overrides };
}

function task(overrides: Partial<RoutingTask> = {}): RoutingTask {
  return { id: 20, ownerId: LYUDMILA, entityType: "leads", entityId: 10, completed: false, text: "Follow up", ...overrides };
}

function setup() {
  const crm = {
    getLead: vi.fn().mockResolvedValue(lead()),
    getTask: vi.fn().mockResolvedValue(task()),
    getContact: vi.fn().mockResolvedValue({ id: 30, ownerId: LYUDMILA, leadIds: [10] }),
    isUserActive: vi.fn().mockResolvedValue(true),
    listLeadTasks: vi.fn().mockResolvedValue([task()]),
    listShiftLeads: vi.fn().mockResolvedValue({ leads: [lead()], hasNext: false }),
    setLeadOwner: vi.fn().mockResolvedValue(undefined),
    setTaskOwners: vi.fn().mockResolvedValue(undefined),
    setContactOwner: vi.fn().mockResolvedValue(undefined),
    createReplyTask: vi.fn().mockResolvedValue(undefined)
  };
  const deps = {
    crm, now: NOW, dutyOwnerIds: [PHILIPP],
    getDutyOwner: vi.fn().mockResolvedValue(PHILIPP),
    enqueue: vi.fn().mockResolvedValue(undefined),
    beforeCreateReply: vi.fn().mockResolvedValue(undefined),
    assertRunning: vi.fn()
  } satisfies RoutingDependencies;
  return deps;
}

describe("routing new deals", () => {
  it("assigns only the new main-pipeline deal and its first eligible open task", async () => {
    const deps = setup();
    deps.crm.listLeadTasks.mockResolvedValue([task({ id: 19, completed: true }), task(), task({ id: 21 })]);
    expect(await handleRoutingWork({ kind: "lead", leadId: 10 }, deps)).toMatchObject({ status: "processed" });
    expect(deps.crm.setLeadOwner).toHaveBeenCalledWith(10, PHILIPP);
    expect(deps.crm.setTaskOwners).toHaveBeenCalledExactlyOnceWith([20], PHILIPP);
    expect(deps.crm.createReplyTask).not.toHaveBeenCalled();
  });

  it.each([
    { statusId: AMO_STATUS.WORK }, { pipelineId: 1 }, { ownerId: 99 }, { ownerId: ARTEM }, { tags: [{ id: 321809, name: "Personal" }] }
  ])("does not overwrite a deal outside scope: %j", async (fields) => {
    const deps = setup();
    deps.crm.getLead.mockResolvedValue(lead(fields));
    expect(await handleRoutingWork({ kind: "lead", leadId: 10 }, deps)).toMatchObject({ status: "skipped" });
    expect(deps.crm.setLeadOwner).not.toHaveBeenCalled();
    expect(deps.crm.setTaskOwners).not.toHaveBeenCalled();
  });

  it("skips an unconfigured duty shift", async () => {
    const deps = setup();
    deps.getDutyOwner.mockResolvedValue(null);
    expect(await handleRoutingWork({ kind: "lead", leadId: 10 }, deps)).toMatchObject({ status: "skipped" });
    expect(deps.crm.setLeadOwner).not.toHaveBeenCalled();
  });
});

describe("routing new tasks", () => {
  it("updates the task but does not reassign the deal", async () => {
    const deps = setup();
    expect(await handleRoutingWork({ kind: "task", taskId: 20 }, deps)).toMatchObject({ status: "processed" });
    expect(deps.crm.setTaskOwners).toHaveBeenCalledWith([20], PHILIPP);
    expect(deps.crm.setLeadOwner).not.toHaveBeenCalled();
  });

  it.each([
    { completed: true }, { entityType: null }, { entityType: "contacts" }, { ownerId: ARTEM }, { ownerId: 99 },
    { text: "\u041e\u0442\u043a\u043e\u0441\u044b: \u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u043a\u043e\u043c\u0438\u0441\u0441\u0438\u044e, \u0437\u0430\u043a\u0440\u044b\u0442\u044c \u0441\u0434\u0435\u043b\u043a\u0443." }
  ])("skips ineligible tasks: %j", async (fields) => {
    const deps = setup();
    deps.crm.getTask.mockResolvedValue(task(fields));
    expect(await handleRoutingWork({ kind: "task", taskId: 20 }, deps)).toMatchObject({ status: "skipped" });
    expect(deps.crm.setTaskOwners).not.toHaveBeenCalled();
  });

  it("preserves the task owner of a personal deal", async () => {
    const deps = setup();
    deps.crm.getLead.mockResolvedValue(lead({ tags: [{ id: 321809, name: "Personal" }] }));
    expect(await handleRoutingWork({ kind: "task", taskId: 20 }, deps)).toMatchObject({ status: "skipped" });
    expect(deps.crm.setTaskOwners).not.toHaveBeenCalled();
  });
});

describe("routing inbound messages", () => {
  const message = { kind: "message", leadId: 10, messageId: "message-1", channel: "vk" } as const;

  it("updates a duty-owned deal and records the intent before creating a linked reply task", async () => {
    const deps = setup();
    await handleRoutingWork(message, deps);
    expect(deps.crm.setLeadOwner).toHaveBeenCalledWith(10, PHILIPP);
    expect(deps.beforeCreateReply).toHaveBeenCalledTimes(1);
    expect(deps.beforeCreateReply.mock.invocationCallOrder[0]).toBeLessThan(deps.crm.createReplyTask.mock.invocationCallOrder[0]);
    expect(deps.crm.createReplyTask).toHaveBeenCalledExactlyOnceWith(10, PHILIPP, replyText, Math.floor(NOW.getTime() / 1000));
  });

  it("does not create another open reply task for the same deal and channel", async () => {
    const deps = setup();
    deps.crm.listLeadTasks.mockResolvedValue([task({ text: replyText })]);
    await handleRoutingWork(message, deps);
    expect(deps.beforeCreateReply).not.toHaveBeenCalled();
    expect(deps.crm.createReplyTask).not.toHaveBeenCalled();
  });

  it("keeps the active owner of a personal deal", async () => {
    const deps = setup();
    deps.crm.getLead.mockResolvedValue(lead({ ownerId: 42, tags: [{ id: 321809, name: "Personal" }] }));
    await handleRoutingWork(message, deps);
    expect(deps.crm.isUserActive).toHaveBeenCalledWith(42);
    expect(deps.crm.createReplyTask).toHaveBeenCalledWith(10, 42, replyText, expect.any(Number));
    expect(deps.crm.setLeadOwner).not.toHaveBeenCalled();
  });

  it("skips Wazzup on an open deal and unknown owners on ordinary deals", async () => {
    const deps = setup();
    await handleRoutingWork({ ...message, channel: "wazzup" }, deps);
    deps.crm.getLead.mockResolvedValue(lead({ ownerId: 99 }));
    await handleRoutingWork(message, deps);
    expect(deps.crm.createReplyTask).not.toHaveBeenCalled();
    expect(deps.crm.setLeadOwner).not.toHaveBeenCalled();
  });

  it("allows a Wazzup reply for a closed deal and protects the SPb owner", async () => {
    const deps = setup();
    deps.crm.getLead.mockResolvedValue(lead({ ownerId: ARTEM, statusId: AMO_STATUS.COMMISSION_RECEIVED }));
    await handleRoutingWork({ ...message, channel: "wazzup" }, deps);
    expect(deps.crm.createReplyTask).toHaveBeenCalledWith(10, ARTEM, expect.stringContaining("\u0412\u0430\u0442\u0441\u0430\u043f"), expect.any(Number));
    expect(deps.crm.setLeadOwner).not.toHaveBeenCalled();
  });

  it("returns needs_review after an ambiguous create instead of retrying the POST", async () => {
    const deps = setup();
    deps.crm.createReplyTask.mockRejectedValue(new Error("network failure"));
    expect(await handleRoutingWork(message, deps)).toMatchObject({ status: "needs_review" });
    expect(deps.crm.createReplyTask).toHaveBeenCalledTimes(1);
  });
});

describe("shift rotation", () => {
  it("previews protected shared contacts and preserves unrelated or closed tasks without writes", async () => {
    const deps = setup();
    deps.crm.getContact.mockResolvedValue({ id: 30, ownerId: LYUDMILA, leadIds: [10, 11] });
    deps.crm.listLeadTasks.mockResolvedValue([task(), task({ id: 21, completed: true }), task({ id: 22, ownerId: 99 })]);
    const preview = await previewRoutingShift(deps, 1);
    expect(preview).toMatchObject({ ownerId: PHILIPP, actions: [{ leadId: 10, changeLeadOwner: true, taskIds: [20], contactId: null }] });
    expect(deps.crm.setLeadOwner).not.toHaveBeenCalled();
    expect(deps.crm.setTaskOwners).not.toHaveBeenCalled();
    expect(deps.crm.setContactOwner).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("queues one bounded page of eligible deals and its continuation", async () => {
    const deps = setup();
    deps.crm.listShiftLeads.mockResolvedValue({ leads: [lead(), lead({ id: 11, statusId: AMO_STATUS.REFUSED })], hasNext: true });
    await handleRoutingWork({ kind: "shift-scan", day: DAY, page: 1 }, deps);
    expect(deps.enqueue).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ dedupe_key: `shift:${DAY}:lead:10`, payload: { kind: "shift-lead", day: DAY, ownerId: PHILIPP, leadId: 10 } }),
      expect.objectContaining({ dedupe_key: `shift:${DAY}:scan:2`, payload: { kind: "shift-scan", day: DAY, ownerId: PHILIPP, page: 2 } })
    ]);
    expect(deps.crm.setLeadOwner).not.toHaveBeenCalled();
  });

  it("transfers the eligible deal, open tasks and unshared first contact", async () => {
    const deps = setup();
    await handleRoutingWork({ kind: "shift-lead", day: DAY, ownerId: PHILIPP, leadId: 10 }, deps);
    expect(deps.crm.setLeadOwner).toHaveBeenCalledWith(10, PHILIPP);
    expect(deps.crm.setTaskOwners).toHaveBeenCalledWith([20], PHILIPP);
    expect(deps.crm.setContactOwner).toHaveBeenCalledWith(30, PHILIPP);
  });

  it("does not apply a rotation once the date or selected manager changes", async () => {
    const deps = setup();
    await handleRoutingWork({ kind: "shift-lead", day: "04.11.2026", ownerId: PHILIPP, leadId: 10 }, deps);
    await handleRoutingWork({ kind: "shift-lead", day: DAY, ownerId: 100, leadId: 10 }, deps);
    expect(deps.crm.setLeadOwner).not.toHaveBeenCalled();
    expect(deps.crm.setTaskOwners).not.toHaveBeenCalled();
    expect(deps.crm.setContactOwner).not.toHaveBeenCalled();
  });
});
