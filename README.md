# DveriOpt24 backend

Vercel/Next.js backend для обработки webhook-событий amoCRM, пересчёта KPI и безопасной синхронизации с Google Sheets через очередь в Supabase.

## Что уже реализовано

- `POST /api/webhooks/amocrm` принимает raw webhook amoCRM и складывает события в `dveri_opt_webhook_events`
- `GET/POST /api/cron/process-queue` забирает webhook-события и sheet jobs из очереди
- state-based расчёт KPI с учётом:
  - `Тип объекта`
  - статусов сделки
  - freeze после `Комиссия получена`
  - обнуления денежных KPI при `Отказ`
- сумма KPI считается как `8%` от бюджета сделки amoCRM
- смена этапа и изменение бюджета используют единый расчёт по текущему состоянию сделки
- пропуск этапов восстанавливает положенные KPI, включая переход сразу в `Ожидание получения комиссии`
- существующие даты и менеджеры KPI сохраняются; недостающие определяются по истории этапов и ответственных
- для типа `Входная` оплачиваются `Замер` и `Монтаж`, а `В работу` остаётся `0`
- синхронизация KPI-полей в amoCRM
- очередь записи в `KP new` и `ЗП new` с retry/backoff
- миграция Supabase с таблицами `dveri_opt_*`

## Google Sheets авторизация

Для этого проекта выбран `service account`.

Нужно:

1. Создать проект в Google Cloud.
2. Включить `Google Sheets API`.
3. Создать `Service Account`.
4. Сгенерировать JSON key.
5. Добавить email service account как `Editor` в нужную таблицу.
6. Перенести `client_email` и `private_key` в env Vercel.

## Локальный запуск

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Supabase

Примените миграцию:

- [supabase/migrations/0001_dveri_opt_init.sql](/Users/antonterentev/Documents/DveriOpt24/supabase/migrations/0001_dveri_opt_init.sql)

Для server-side вызовов нужен именно `service_role` ключ Supabase.
`anon`/public key для очереди не подойдёт: RPC `dveri_opt_claim_*` и запись в служебные таблицы будут падать.

Для вызовов amoCRM backend использует встроенный limiter и retry на временные ошибки API.
Базовые настройки:

- `AMOCRM_MIN_REQUEST_INTERVAL_MS=220`
- `AMOCRM_MAX_RETRIES=4`
- `AMOCRM_RETRY_BASE_DELAY_MS=500`
- `AMOCRM_RETRY_MAX_DELAY_MS=5000`

Примените также миграции очереди:

- [supabase/migrations/0002_add_last_budget_to_deal_state.sql](/Users/antonterentev/Documents/DveriOpt24/supabase/migrations/0002_add_last_budget_to_deal_state.sql)
- [supabase/migrations/0003_add_queue_history_cleanup.sql](/Users/antonterentev/Documents/DveriOpt24/supabase/migrations/0003_add_queue_history_cleanup.sql)
- [supabase/migrations/0004_add_sheet_job_history_cleanup.sql](/Users/antonterentev/Documents/DveriOpt24/supabase/migrations/0004_add_sheet_job_history_cleanup.sql)

## Запуск очереди в Coolify

В production очередь запускает задача `DveriOpt24 Process Queue` в разделе **Scheduled Tasks** приложения `dveriopt24`. Она вызывает обработчик внутри контейнера, без запроса через внешний домен.

- Расписание: `* * * * *` (раз в минуту).
- Timeout: `180` секунд. Поле Container оставьте пустым для приложения с одним контейнером.
- В окружении приложения должен быть задан `CRON_SECRET`. Не вставляйте его значение в команду задачи.

Команда (не более 255 символов в используемой версии Coolify):

```sh
node -e 'fetch("http://127.0.0.1:3000/api/cron/process-queue",{method:"POST",headers:{Authorization:"Bearer "+process.env.CRON_SECRET},signal:AbortSignal.timeout(150000)}).then(async r=>{if(!r.ok)throw Error(r.status);console.log(await r.text())})'
```

После настройки проверьте в **Executions**, что автоматический запуск завершился со статусом `Success`, а ответ содержит `"ok":true`. Нулевые счётчики нормальны, когда очередь пуста.

Прежний workflow `DveriOpt24 - Process Queue Cron` в n8n отключён и сохранён для отката. Если нужно вернуться к n8n, сначала отключите задачу Coolify и дождитесь завершения текущего запуска, затем включите workflow.

## Маршрутизация amoCRM

В приложении есть четыре сценария: новые сделки основного конвейера на этапе «Новая», новые задачи, входящие сообщения и ежедневная смена ответственных. По умолчанию оба переключателя выключены: KPI продолжает работать, webhook маршрутизации отвечает `404`, очередь маршрутизации не опрашивается.

Перед отдельным включением:

1. Примените `0007_create_routing_jobs.sql` и `0008_routing_queue_functions.sql` поверх актуальной схемы. Приложение использует прежний `service_role`.
2. Укажите `CRM_SHIFT_SPREADSHEET_ID` для отдельной таблицы с листом «График работы» и дайте сервисному аккаунту доступ на чтение. В колонках «Дата», «Филипп», «Светлана» должна быть одна строка на день и одна отметка `1`. Филипп уже сопоставлен с ID `7268314`. Не задавайте `CRM_SVETLANA_USER_ID`, пока не подтверждён её ID: её смены не будут назначаться на другого сотрудника.
3. Проверьте предпросмотр для текущего дня по Москве. Он доступен при выключенных сценариях и не меняет сделки, задачи, контакты или очередь.

   ```sh
   curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" "${APP_URL}/api/routing/shift-preview?page=1"
   ```

4. Для будущего включения webhook задайте отдельный случайный `CRM_ROUTING_WEBHOOK_SECRET` и `CRM_ROUTING_ENABLED=true`. Подписка amoCRM на `add_lead`, `add_task`, `add_message` использует `POST /api/webhooks/amocrm-routing?secret=<URL-encoded secret>`. Если отправитель умеет задавать заголовки, используйте `X-Webhook-Secret` вместо query. Не публикуйте URL подписки и скрывайте query в журналах. Не меняйте подписку KPI.
5. Включайте `CRM_SHIFT_ROTATION_ENABLED=true` только после проверки предпросмотра. Тот же cron поставит смену в очередь один раз за московский день в окне 03:00–03:04. Если окно пропущено, автоматического запуска задним числом нет.

Данные о завершённых, пропущенных и неудачных заданиях хранятся один день. `needs_review` сохраняется для ручной проверки: если результат создания задачи неясен, сначала проверьте задачи в сделке. Автоматического повторного POST в этом случае нет.

## Retention очереди

`/api/cron/process-queue` теперь не только обрабатывает очередь, но и подчищает старую историю небольшими батчами.

По умолчанию:

- `WEBHOOK_EVENTS_RETENTION_DAYS=1`
- `SHEET_JOBS_RETENTION_DAYS=1`

Дополнительно можно настроить размер батчей очистки:

- `WEBHOOK_EVENTS_CLEANUP_BATCH_SIZE`
- `WEBHOOK_EVENTS_FAILED_CLEANUP_BATCH_SIZE`
- `SHEET_JOBS_CLEANUP_BATCH_SIZE`
- `SHEET_JOBS_FAILED_CLEANUP_BATCH_SIZE`

Это уменьшает рост таблиц, но физический размер в Postgres может снижаться не мгновенно: после больших удалений базе ещё нужно время на reclaim space.

## Vercel

Рабочее приложение размещено в Coolify: `https://dveriopt24.pr.crmkit.ru`. Ветка публикации — `main`, сборка — через `Dockerfile`.
`GET /api/health` возвращает `kpiRulesVersion: 2` для версии с единым расчётом.

Настройки Vercel ниже сохранены для альтернативного развёртывания.

- в проекте нужен `CRON_SECRET`
- файл [vercel.json](/Users/antonterentev/Documents/DveriOpt24/vercel.json) больше не содержит встроенный Vercel Cron
- при развёртывании вне Coolify настройте отдельный планировщик для `POST /api/cron/process-queue` с заголовком `Authorization: Bearer <CRON_SECRET>`

## Важно по безопасности

- Не храните amoCRM токен и Google private key в репозитории.
- Локальный файл `AGENTS.md` уже добавлен в `.gitignore`, чтобы не утащить секреты в GitHub по ошибке.
