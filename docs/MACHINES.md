# Machines and presence

See which computers run Crew and whether each is online right now. Open **🖥 Machines** in the header.

- One Crew install is the **hub**. It shows itself plus every machine paired to it.
- Other installs send a small heartbeat every 30 seconds (machine name, OS, Crew version, idle or "N agents working").
- A machine shows **online** if the hub heard from it in the last 90 seconds, otherwise **offline** with the last-seen time.
- Nothing about your chats, files or agents is sent. Only those few fields.

## 1. Set up the hub (the computer that stays on)

Nothing to configure. Restart Crew and the Machines button appears. Optionally set a friendlier name in `crew.config.json` under `settings`:

```json
"machineName": "Desktop"
```

For other computers on your home network to reach the hub, set `"allowLan": true` (see the main README).

## 2. Pair another computer

1. On the hub, open **Machines → Get pairing code**. The code works once and expires after 10 minutes. Five wrong guesses lock pairing for 10 minutes.
2. On the other computer, add this under `settings` in its `crew.config.json`, then restart Crew:

```json
"machineName": "Laptop",
"presenceHub": { "url": "http://HUB-PC-ADDRESS:7777", "pairCode": "THE-CODE" }
```

3. It pairs itself and stores its own secret in `data/presence-client.json`. You can delete `pairCode` from the config afterwards. Remove a machine any time with **Remove** in the panel, and it stops being accepted.

The hub stores only a hash of each machine's secret (`data/presence.json`).

## 3. Reaching the hub from outside your home (optional)

Use this only if you want machines to report from anywhere. It needs the Cloudflare setup from the main README ("Internet access") already working, so the hub is at something like `https://crew.example.com`. Do not open router ports or share the local address on the internet.

A machine is not a person, so it can't sign in with email. Cloudflare Access lets it through with a **service token**.

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Service credentials** (older UI: *Access → Service Auth*) → **Create Service Token**. Name it, e.g. `crew-machines`, and pick a long duration. **Copy the Client ID and Client Secret now.** The secret is shown once.
2. Zero Trust → **Access** → **Applications** → open your Crew application → **Policies** → **Add a policy**:
   - Name: `Crew machines`
   - Action: **Service Auth**
   - Include: **Service Token** → `crew-machines`
   - Save. Keep your existing email policy as it is.
3. On each remote computer, extend `presenceHub` in `crew.config.json`:

```json
"presenceHub": {
  "url": "https://crew.example.com",
  "pairCode": "THE-CODE",
  "cfClientId": "xxxx.access",
  "cfClientSecret": "xxxx"
}
```

4. Restart Crew there. The service token only gets a machine past Cloudflare, and the hub accepts it for the two presence endpoints (`/api/presence/pair` and `/api/presence/beat`) and nothing else. Everything else in Crew still needs your email login. Each machine also still needs its own pairing secret.

Treat the Client Secret like a password. If it leaks, delete the token in Cloudflare and make a new one.

## How it works (for contributors)

- `lib/presence.js`: hub store, pairing, heartbeat check, and the client sender.
- `server.js`: `POST /api/presence/pair` and `/beat` (machine secret, no browser login), `GET /api/machines`, `POST /api/machines/pair` and `/remove` (signed-in users only).
- `public/index.html`: the Machines panel.
