# Telegram alerts from [EnergoPro Georgia](https://my.energo-pro.ge/ow/#/disconns)

Reads alerts from EnergoPro Georgia API for a city (defaults to Batumi), translates them and sends a notification to a Telegram channel or chat.

Designed to run on gcloud free tier (Cloud Run functions, Firestore, cron).

Currently, only a single chat is supported and some defaults are hardcoded since the bot was made for personal use. Please file an issue if you're actually using the bot and need that. Same if you need a truly local instance (e.g. with SQLite).

## Environment variables

Usually, set to env.yaml (see env.example.yaml). Set them in .env file (see .env.local.example) if you want to run locally (e.g. for tests).

| Variable Name           | Description                                        | Default value                                |
| ----------------------- | -------------------------------------------------- | -------------------------------------------- |
| API_ENDPOINT            | API endpoint, see env example for default          | https://my.energo-pro.ge/owback/searchAlerts |
| CITY                    | City to watch, see env example for default         | ბათუმი (Batumi)                              |
| FIRESTORE_COLLECTION_ID | ID of the Firestore collection for processed tasks | -                                            |
| FIRESTORE_DATABASE_ID   | Firestore database                                 | -                                            |
| GEMINI_API_KEY          | API key for Gemini                                 | -                                            |
| GEMINI_MODEL            | Default Gemini model                               | gemini-2.5-flash                             |
| TELEGRAM_BOT_TOKEN      | Token for your Telegram bot                        | -                                            |
| TELEGRAM_CHAT_ID        | ID of the telegram chat/channel used for messages  | -                                            |

## Sample deployment

Install, set up and authorize`gcloud` CLI. Then, deploy like this:

```
gcloud functions deploy power-outage-parser \
        --runtime=nodejs24 \
        --trigger-http \
        --entry-point=checkPowerOutages \
        --allow-unauthenticated \
        --gen2 \
        --region=europe-west4 \
        --memory=256Mi \
        --env-vars-file=env.yaml
```

Note the entry point (don't change it) and the env vars file.

After deployment, you will see a function URL. Add a cron job for it:

```
gcloud scheduler jobs create http power-outage-cron \
        --schedule="*/10 * * * *" \
        --uri="YOUR_GCLOUD_FUNCTION_URL" \
        --http-method=GET \
        --location=europe-west4
```

This runs a cron job every 10 mins which is usually more than enough. Note that the same region is used in function and cron job deployment.

## Seen-tasks index (saves Firestore reads)

Instead of one Firestore `get()` per task per run, the function keeps a single
index doc (default `_meta/seen_task_ids`, override via `FIRESTORE_SEEN_INDEX`)
mapping processed task IDs to `true`. Each run costs 1 index read; new tasks are
added with a single merged write. Per-task docs in `FIRESTORE_COLLECTION_ID`
are still written as before.

Backfill the index once after deploying (with the cron job disabled):

1. Deploy with `BACKFILL_INDEX: "true"` in `env.yaml`.
2. Trigger once: `curl "$FUNCTION_URL?backfill=true"` — sends no Telegram messages.
3. Verify the index doc exists and its ID count matches the collection size.
4. Set `BACKFILL_INDEX: "false"` and redeploy.

Until the index exists, normal runs skip processing (no re-alerts).

## Running locally (e.g. for tests)

Set all necessary variables to `.env` file. Then, run:

```
node --env-file=.env run-locally.mjs
```
