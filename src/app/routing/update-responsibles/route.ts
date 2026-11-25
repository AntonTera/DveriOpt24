import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isRoutingEnabled, isShiftRotationEnabled, matchesSecret } from "@/lib/routing/config";
import { enqueueRoutingJobs, getManualShiftRequest } from "@/lib/routing/repository";
import { formatDisplayDate } from "@/lib/utils/datetime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_NAME = "__Host-dveriopt24-shift";
const ENROLLMENT_PURPOSE = "dveriopt24-manual-shift-enrollment";
const ACCESS_SECONDS = 180 * 24 * 60 * 60;
const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow"
};

function getSecret() {
  const secret = process.env.CRM_SHIFT_LINK_SECRET;
  return isRoutingEnabled() && isShiftRotationEnabled() && secret && /^[a-f0-9]{64}$/u.test(secret)
    ? secret : null;
}

function signature(purpose: string, expires: string, secret: string) {
  return createHmac("sha256", secret).update(`${purpose}:${expires}`).digest("hex");
}

function isSignedToken(value: string | null | undefined, purpose: string, secret: string) {
  const match = value?.match(/^(\d{10})\.([a-f0-9]{64})$/u);
  return Boolean(match && Number(match[1]) > Math.floor(Date.now() / 1000) &&
    matchesSecret(match[2], signature(purpose, match[1], secret)));
}

function hasAccess(request: Request, secret: string) {
  const cookie = request.headers.get("cookie")?.split(";")
    .map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  return isSignedToken(cookie?.slice(COOKIE_NAME.length + 1), COOKIE_NAME, secret);
}

function json(status: string, code = 200) {
  return Response.json({ status }, { status: code, headers: HEADERS });
}

function renderPage(authorized: boolean, autoRun: boolean) {
  const nonce = randomBytes(18).toString("base64");
  return new Response(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Обновить ответственных · DveriOpt24</title>
<style nonce="${nonce}">
body{margin:0;background:#f5f5f0;color:#1f2937;font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;margin:12vh auto;padding:2rem;background:white;border:1px solid #dedfd6;border-radius:16px}
h1{margin:0 0 1rem;font-size:1.55rem;line-height:1.2}
p{margin:0 0 1.25rem}
input,button{box-sizing:border-box;font:inherit;border-radius:8px}
input{display:block;width:100%;padding:.6rem .7rem;border:1px solid #a3a99e;margin:.4rem 0 .85rem}
button{padding:.6rem .9rem;color:white;background:#1b5e45;border:1px solid #1b5e45;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
@media(max-width:560px){main{margin:2rem 1rem;padding:1.4rem}}
</style>
</head>
<body data-authorized="${authorized}" data-auto-run="${autoRun}">
<main>
<h1>Обновить ответственных</h1>
<p id="status" role="status">${authorized ? "Проверим дежурного по графику." : "Подключите этот браузер, чтобы запускать смену по ссылке из таблицы."}</p>
<form id="access" ${authorized ? "hidden" : ""}>
<label for="access-code">Код доступа</label>
<input id="access-code" type="password" autocomplete="off" required>
<button type="submit">Подключить браузер</button>
</form>
<button id="start" type="button" ${authorized ? "" : "hidden"}>Проверить график</button>
<noscript>Для запуска нужен JavaScript.</noscript>
</main>
<script nonce="${nonce}">
(() => {
const status = document.getElementById("status");
const access = document.getElementById("access");
const input = document.getElementById("access-code");
const start = document.getElementById("start");
const autoRun = document.body.dataset.autoRun === "true";
const authorized = document.body.dataset.authorized === "true";
const endpoint = location.pathname;
let busy = false;

async function submit(action, code) {
  const headers = { "X-Dveri-Shift-Action": action };
  if (code) headers["X-Dveri-Shift-Code"] = code;
  return fetch(endpoint, { method: "POST", headers, mode: "same-origin" });
}

async function enroll(code) {
  if (busy) return;
  busy = true;
  try {
    const response = await submit("enroll", code);
    if (!response.ok) {
      status.textContent = response.status === 401 ? "Неверный код доступа." : "Не удалось подключить браузер. Попробуйте ещё раз.";
      return;
    }
    input.value = "";
    access.hidden = true;
    start.hidden = false;
    status.textContent = "Браузер подключён. Теперь можно запускать смену по ссылке из таблицы.";
  } catch {
    status.textContent = "Не удалось подключить браузер. Попробуйте ещё раз.";
  } finally {
    busy = false;
  }
}

const messages = {
  queued: "Смена ответственных поставлена в очередь.",
  unchanged: "Дежурный по графику не изменился. Смена не запущена.",
  no_owner: "В графике на сегодня нет однозначно отмеченного активного дежурного.",
  expired: "Дата сменилась. Откройте ссылку заново, чтобы проверить актуальный график.",
  failed: "Не удалось проверить график или запустить смену. Попробуйте ещё раз."
};

async function launch() {
  if (busy) return;
  busy = true;
  start.disabled = true;
  status.textContent = "Проверяем дежурного по графику…";
  try {
    const response = await submit("start");
    if (response.status === 401) {
      access.hidden = false;
      start.hidden = true;
      status.textContent = "Подключите браузер повторно.";
      return;
    }
    if (!response.ok) throw Error("Start failed");
    const { id } = await response.json();
    for (let attempt = 0; attempt < 27; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const response = await fetch(endpoint + "?run=" + encodeURIComponent(id), { mode: "same-origin" });
      if (!response.ok) throw Error("Status failed");
      const { status: state } = await response.json();
      if (state === "waiting") continue;
      status.textContent = messages[state] || messages.failed;
      return;
    }
    status.textContent = "Запрос сохранён. Очередь продолжит проверку графика.";
  } catch {
    status.textContent = messages.failed;
  } finally {
    busy = false;
    start.disabled = false;
  }
}

access.addEventListener("submit", (event) => {
  event.preventDefault();
  void enroll(input.value.trim());
});
start.addEventListener("click", () => void launch());

const setup = new URLSearchParams(location.hash.slice(1)).get("access");
if (setup !== null) {
  history.replaceState(null, "", endpoint);
  if (!authorized) {
    input.value = setup;
    if (autoRun) void enroll(setup);
  }
} else if (authorized && autoRun) {
  void launch();
}
})();
</script>
</body>
</html>`, {
    headers: {
      ...HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
    }
  });
}

export async function GET(request: Request) {
  const secret = getSecret();
  if (!secret) return json("disabled", 404);
  const hasSession = hasAccess(request, secret);
  const id = new URL(request.url).searchParams.get("run");
  if (id === null) {
    const clicked = request.headers.get("sec-fetch-user") === "?1" &&
      request.headers.get("sec-fetch-mode") === "navigate" && request.headers.get("sec-fetch-dest") === "document";
    return renderPage(hasSession, clicked);
  }

  if (!hasSession) return json("unauthorized", 401);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id)) {
    return json("invalid", 400);
  }

  try {
    const run = await getManualShiftRequest(id);
    if (!run) return json("missing", 404);
    if (["pending", "processing", "retry"].includes(run.status)) return json("waiting");
    if (run.status === "processed") return json("queued");
    switch (run.result?.reason) {
      case "shift_owner_unchanged": return json("unchanged");
      case "no_duty_owner": return json("no_owner");
      case "shift_date_changed": return json("expired");
      default: return json("failed");
    }
  } catch {
    return json("unavailable", 503);
  }
}

export async function POST(request: Request) {
  const secret = getSecret();
  if (!secret) return json("disabled", 404);
  if (request.headers.get("sec-fetch-site") !== "same-origin") return json("forbidden", 403);
  const action = request.headers.get("x-dveri-shift-action");

  if (action === "enroll") {
    if (!isSignedToken(request.headers.get("x-dveri-shift-code"), ENROLLMENT_PURPOSE, secret)) {
      return json("unauthorized", 401);
    }
    const expires = String(Math.floor(Date.now() / 1000) + ACCESS_SECONDS);
    const cookie = `${COOKIE_NAME}=${expires}.${signature(COOKIE_NAME, expires, secret)}; Path=/; Max-Age=${ACCESS_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
    return Response.json({ status: "authorized" }, { headers: { ...HEADERS, "Set-Cookie": cookie } });
  }

  if (action !== "start") return json("invalid", 400);
  if (!hasAccess(request, secret)) return json("unauthorized", 401);

  const now = new Date();
  const id = randomUUID();
  try {
    await enqueueRoutingJobs([{
      dedupe_key: `shift-request:${id}`,
      payload: { kind: "shift-request", day: formatDisplayDate(now), source: "manual" },
      next_run_at: now.toISOString()
    }]);
    return Response.json({ id }, { status: 202, headers: HEADERS });
  } catch {
    return json("unavailable", 503);
  }
}
