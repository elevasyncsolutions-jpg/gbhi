# Solana Dream Engine V3 Auto

Railway-ready Solana autopilot with **scanner + AI score + Telegram + hard safety rails + optional hot-wallet execution**.

This is not a guaranteed profit machine. It is an execution framework. Keep `DRY_RUN=true` and `AUTO_TRADING_ENABLED=false` until logs, scores, and Telegram alerts are clean.

## Deploy on Railway

1. Upload repo/ZIP to GitHub or Railway.
2. Set variables from `.env.example`.
3. Run `npm install` locally only if testing locally; Railway installs automatically.
4. Start command: `npm start`.
5. Open `/`, login with `APP_PASSWORD`.

## Safety rules

- Never use your main Phantom private key.
- Create a fresh hot wallet with tiny funds only.
- Start dry-run.
- Max trade default: `0.015 SOL`.
- Daily loss default: `$3`.
- Panic button stops auto trading immediately.

## Environment variables that matter

- `DRY_RUN=true` = never broadcasts trades or payouts.
- `AUTO_TRADING_ENABLED=true` = allows the loop to execute qualified buys/sells.
- `SERVER_WALLET_SECRET_KEY_BASE58` = needed only for real auto execution.
- `AUTO_PAYOUT_ENABLED=true` = sends profit to payout wallet when above reserve.

## Telegram

Create a bot with BotFather, set:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

The engine sends scan, trade, payout, and panic alerts.

## Endpoints

- `GET /api/status`
- `POST /api/login`
- `POST /api/logout`
- `POST /api/scan`
- `POST /api/autopilot/start`
- `POST /api/autopilot/stop`
- `POST /api/panic`
- `POST /api/payout`

## n8n

`workflows/n8n-scan-trigger.json` hits `/api/scan` every 5 minutes and can send results to Telegram.
