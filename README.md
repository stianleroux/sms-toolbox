# SMS Toolbox

Simple two-part SMS relay system:

1. Cloudflare Worker public API to enqueue SMS jobs.
2. React Native (Expo) Android app that polls and sends SMS from the phone.

## Architecture

- `POST /api/sms/enqueue` accepts `{ deviceId, to, text }` and pushes to Cloudflare Queue.
- Worker queue consumer writes jobs into KV per-device inbox.
- Mobile app polls `GET /api/sms/poll?deviceId=...`.
- App sends SMS and calls `POST /api/sms/ack` with status.

## Folder Layout

- `worker`: Cloudflare Worker + Queue + KV logic.
- `mobile-app`: Expo React Native app.

## 1) Cloudflare Worker Setup

### Prereqs

- Node.js 18+
- Cloudflare account
- Wrangler CLI (`npm i -g wrangler` optional; local `npx wrangler` also works)

### Install

```bash
cd worker
npm install
```

### Create Cloudflare resources

```bash
npx wrangler kv namespace create SMS_KV
npx wrangler queues create sms-outbound
```

Copy the KV namespace ID into `worker/wrangler.toml`:

- Replace `REPLACE_WITH_KV_ID` with your real KV id.

### Optional API key

Create `worker/.dev.vars` from `worker/.dev.vars.example`:

```env
API_KEY=your-secret-key
```

If `API_KEY` is empty, API is open.

### Local dev

```bash
cd worker
npm run dev
```

### Deploy

```bash
cd worker
npm run deploy
```

## 2) React Native App Setup

### Install dependencies

```bash
cd mobile-app
npm install
npx expo install expo-sms
```

### Run on Android device

```bash
cd mobile-app
npm run android
```

In the app UI set:

- Worker API URL (example: `https://sms-worker.<your-subdomain>.workers.dev`)
- API key (if configured)
- Device ID (must match enqueue payload)
- Poll interval

Tap `Start` to begin polling.

## 3) Build APK (Expo EAS)

```bash
cd mobile-app
npm install -g eas-cli
eas login
eas build:configure
eas build -p android --profile preview
```

Download APK from the EAS build output.

## 4) Call Public API to Queue SMS

Example request:

```bash
curl -X POST "https://sms-worker.<your-subdomain>.workers.dev/api/sms/enqueue" \
  -H "content-type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{
    "deviceId": "android-phone-1",
    "to": "+15551234567",
    "text": "hello from cloudflare"
  }'
```

## Notes

- `expo-sms` uses native SMS compose/send flow. Some Android versions may require user confirmation for sending.
- For completely silent/automatic SMS sending, you may need a custom native Android module and device policy adjustments.
