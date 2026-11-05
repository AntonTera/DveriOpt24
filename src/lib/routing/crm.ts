import { amoFetch, AmoCrmResponseError } from "@/lib/amocrm/client";
import { MAIN_PIPELINE_ID } from "@/lib/constants/amocrm";

type Owner = { id: number; responsible_user_id: number | null };
type Tag = { id: number; name: string };
type AmoLead = Owner & {
  pipeline_id: number;
  status_id: number;
  _embedded?: { tags?: Tag[]; contacts?: { id: number; is_main?: boolean }[] };
};
type AmoTask = Owner & { entity_type: string | null; entity_id: number | null; is_completed: boolean; text: string };
type AmoContact = Owner & { _embedded?: { leads?: { id: number }[] } };
type AmoPage<T> = { _embedded?: T; _links?: { next?: unknown } };

export type RoutingLead = {
  id: number; pipelineId: number; statusId: number; ownerId: number | null; tags: Tag[]; contactIds: number[];
};
export type RoutingTask = {
  id: number; ownerId: number | null; entityType: string | null; entityId: number | null; completed: boolean; text: string;
};
export type RoutingContact = { id: number; ownerId: number | null; leadIds: number[] | null };

function normalizeLead(lead: AmoLead): RoutingLead {
  const contacts = lead._embedded?.contacts ?? [];
  const main = contacts.find((contact) => contact.is_main);
  return {
    id: lead.id, pipelineId: lead.pipeline_id, statusId: lead.status_id,
    ownerId: lead.responsible_user_id, tags: lead._embedded?.tags ?? [],
    contactIds: main ? [main.id, ...contacts.filter((contact) => contact !== main).map(({ id }) => id)] : contacts.map(({ id }) => id)
  };
}

function normalizeTask(task: AmoTask): RoutingTask {
  return {
    id: task.id, ownerId: task.responsible_user_id, entityType: task.entity_type,
    entityId: task.entity_id, completed: task.is_completed !== false, text: task.text
  };
}

export function createRoutingCrm(signal?: AbortSignal) {
  async function read<T>(path: string, allowMissing = false): Promise<T | null> {
    try {
      const response = await amoFetch(path, { signal, redirect: "error" });
      return response.status === 204 ? null : await response.json() as T;
    } catch (error) {
      if (allowMissing && error instanceof AmoCrmResponseError && error.status === 404) return null;
      throw error;
    }
  }

  async function write(path: string, method: "PATCH" | "POST", body: unknown) {
    const response = await amoFetch(path, {
      method, body: JSON.stringify(body), signal, redirect: "error"
    }, { retry: false });
    return response;
  }

  async function patch(path: string, body: unknown) {
    const response = await write(path, "PATCH", body);
    await response.body?.cancel();
  }

  return {
    async getLead(id: number): Promise<RoutingLead | null> {
      const lead = await read<AmoLead>(`/api/v4/leads/${id}?with=contacts`, true);
      return lead?.id === id ? normalizeLead(lead) : null;
    },
    async getTask(id: number): Promise<RoutingTask | null> {
      const task = await read<AmoTask>(`/api/v4/tasks/${id}`, true);
      return task?.id === id ? normalizeTask(task) : null;
    },
    async getContact(id: number): Promise<RoutingContact | null> {
      const contact = await read<AmoContact>(`/api/v4/contacts/${id}?with=leads`, true);
      return contact?.id === id ? {
        id, ownerId: contact.responsible_user_id, leadIds: contact._embedded?.leads?.map((lead) => lead.id) ?? null
      } : null;
    },
    async isUserActive(id: number): Promise<boolean> {
      const user = await read<{ id: number; rights?: { is_active?: boolean } }>(`/api/v4/users/${id}`, true);
      return user?.id === id && user.rights?.is_active === true;
    },
    async listLeadTasks(leadId: number): Promise<RoutingTask[]> {
      const tasks: RoutingTask[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const query = new URLSearchParams({
          "filter[entity_type]": "leads", "filter[entity_id]": String(leadId),
          "filter[is_completed]": "0", limit: "250", page: String(page)
        });
        const result = await read<AmoPage<{ tasks: AmoTask[] }>>(`/api/v4/tasks?${query}`);
        tasks.push(...(result?._embedded?.tasks ?? []).map(normalizeTask));
        if (!result?._links?.next) return tasks;
      }
      throw new Error("Open task pagination limit exceeded");
    },
    async listShiftLeads(ownerIds: readonly number[], statusIds: readonly number[], page: number, limit: number) {
      const query = new URLSearchParams({ page: String(page), limit: String(limit), "order[id]": "asc" });
      for (const id of ownerIds) query.append("filter[responsible_user_id][]", String(id));
      statusIds.forEach((id, index) => {
        query.append(`filter[statuses][${index}][pipeline_id]`, String(MAIN_PIPELINE_ID));
        query.append(`filter[statuses][${index}][status_id]`, String(id));
      });
      const result = await read<AmoPage<{ leads: AmoLead[] }>>(`/api/v4/leads?${query}`);
      return { leads: (result?._embedded?.leads ?? []).map(normalizeLead), hasNext: Boolean(result?._links?.next) };
    },
    setLeadOwner: (id: number, ownerId: number) =>
      patch(`/api/v4/leads/${id}`, { responsible_user_id: ownerId }),
    setTaskOwners: (ids: number[], ownerId: number) =>
      patch("/api/v4/tasks", ids.map((id) => ({ id, responsible_user_id: ownerId }))),
    setContactOwner: (id: number, ownerId: number) =>
      patch(`/api/v4/contacts/${id}`, { responsible_user_id: ownerId }),
    async createReplyTask(id: number, ownerId: number, text: string, completeTill: number) {
      const response = await write("/api/v4/tasks", "POST", [{
        entity_type: "leads", entity_id: id, responsible_user_id: ownerId, text, complete_till: completeTill
      }]);
      const result = await response.json() as AmoPage<{ tasks: { id: number }[] }>;
      const taskId = result._embedded?.tasks?.[0]?.id;
      if (!taskId || !Number.isSafeInteger(taskId)) throw new Error("Reply task was not confirmed");
    }
  };
}

export type RoutingCrm = ReturnType<typeof createRoutingCrm>;
