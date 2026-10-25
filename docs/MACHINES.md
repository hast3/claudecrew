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

## 2. Connect another computer (about a minute)

1. On the hub, open **Machines → Get pairing code**. The code works once and expires after 10 minutes. Five wrong guesses lock pairing for 10 minutes.
2. On the other computer, open **Machines**. In **Connect this PC to a hub**, type the hub's address (for example `192.168.1.20:7777` or `crew.example.com`) and the code, then press **Connect**.

No config editing and no restart. If something is wrong, the box says what in plain words (wrong or expired code, can't reach the address, blocked by Cloudflare). **Disconnect** undoes it. Remove a machine from the hub with **Remove** and it stops being accepted.

The hub stores only a hash of each machine's secret (`data/presence.json`). The other machine keeps its own secret in `data/presence-client.json`. You can set its display name with `"machineName"` in `crew.config.json`.

## 3. Reaching the hub from outside your home (optional)

Use this only if machines should report from anywhere. It needs the Cloudflare setup from the main README ("Internet access") already working, so the hub is at something like `https://crew.example.com`. Do not open router ports.

Machines are not people, so they can't sign in with email. The simplest fix is one extra Cloudflare Access application that lets only the two check-in calls through. They are protected by the one-time code and each machine's own secret.

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. Hostname `crew.example.com`, path `api/presence/*`.
3. Add a policy: Action **Bypass**, Include **Everyone**. Save.

Your main Crew application and its email login are unchanged, and everything else still needs your login. Cloudflare applies the most specific path first.

Then use **Connect this PC to a hub** with `crew.example.com` as the address.

**Stricter option (service token):** instead of Bypass, create a Service Token (Access → Service credentials), then add a policy with Action **Service Auth** (not Allow) and Include **Service Token**, attached to an application for `api/presence/*`. Add `cfClientId` and `cfClientSecret` under `presenceHub` in the machine's `crew.config.json`. Treat the secret like a password, and don't paste it into chat. If it leaks, delete the token and make a new one.

## How it works (for contributors)

- `lib/presence.js`: hub store, pairing, heartbeat check, the client sender, and `pairOnce` (one-shot pairing with plain-language errors).
- `server.js`: `POST /api/presence/pair` and `/beat` (machine secret, no browser login), `GET /api/machines` and `/api/machines/link`, `POST /api/machines/pair`, `/connect`, `/disconnect` and `/remove` (this computer only, or signed-in users).
- `public/index.html`: the Machines panel.
