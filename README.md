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

Примените также миграции очереди:

- [supabase/migrations/0002_add_last_budget_to_deal_state.sql](/Users/antonterentev/Documents/DveriOpt24/supabase/migrations/0002_add_last_budget_to_deal_state.sql)
- [supabase/migrations/0003_add_queue_history_cleanup.sql](/Users/antonterentev/Documents/DveriOpt24/supabase/migrations/0003_add_queue_history_cleanup.sql)

## Запуск очереди через n8n

На бесплатном плане Vercel cron нельзя запускать чаще одного раза в день, поэтому этот проект рассчитан на внешний триггер из `n8n`.

Что настроить:

1. Добавить в Vercel переменную `CRON_SECRET`.
2. В `n8n` создать `Schedule Trigger`.
3. После него вызвать `GET` или `POST` на endpoint:

```text
https://<your-project>.vercel.app/api/cron/process-queue
```

4. Передать заголовок:

```text
Authorization: Bearer <CRON_SECRET>
```

Рекомендуемый интервал в `n8n`: раз в 1-5 минут.

## Retention очереди

`/api/cron/process-queue` теперь не только обрабатывает очередь, но и подчищает старую историю небольшими батчами.

По умолчанию:

- `WEBHOOK_EVENTS_RETENTION_DAYS=7`
- `SHEET_JOBS_RETENTION_DAYS=7`

Дополнительно можно настроить размер батчей очистки:

- `WEBHOOK_EVENTS_CLEANUP_BATCH_SIZE`
- `WEBHOOK_EVENTS_FAILED_CLEANUP_BATCH_SIZE`
- `SHEET_JOBS_CLEANUP_BATCH_SIZE`
- `SHEET_JOBS_FAILED_CLEANUP_BATCH_SIZE`

Это уменьшает рост таблиц, но физический размер в Postgres может снижаться не мгновенно: после больших удалений базе ещё нужно время на reclaim space.

## Vercel

- в проекте нужен `CRON_SECRET`
- файл [vercel.json](/Users/antonterentev/Documents/DveriOpt24/vercel.json) больше не содержит встроенный Vercel Cron
- очередь запускается внешним scheduler-ом, например `n8n`

## Важно по безопасности

- Не храните amoCRM токен и Google private key в репозитории.
- Локальный файл `AGENTS.md` уже добавлен в `.gitignore`, чтобы не утащить секреты в GitHub по ошибке.
