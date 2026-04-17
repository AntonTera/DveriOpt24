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

## Vercel

- в проекте нужен `CRON_SECRET`
- cron настроен в [vercel.json](/Users/antonterentev/Documents/DveriOpt24/vercel.json)
- production cron вызывает `/api/cron/process-queue`

## Важно по безопасности

- Не храните amoCRM токен и Google private key в репозитории.
- Локальный файл `AGENTS.md` уже добавлен в `.gitignore`, чтобы не утащить секреты в GitHub по ошибке.
