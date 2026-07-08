# Gander on your phone (and other machines)

Gander is a **PWA** — open the dashboard on your phone, add it to your home screen, and it installs as a standalone app: full-screen live floor, no browser chrome. This guide covers getting there **securely**.

## The security model

- **Loopback only, by default.** The bridge binds `127.0.0.1` — nothing else on your network can even connect. This is the safe default; nothing to do.
- **`AOC_ALLOW_REMOTE=1`** (or `"allowRemote": true` in `bridge/aoc-config.json`) makes the bridge listen on all interfaces, so other devices can reach `http://<your-pc>:3131`. The dashboard can **start sessions, run commands, and edit config on your machine** — so never do this without the token below.
- **The access token.** Set `"accessToken": "some-long-random-string"` in `bridge/aoc-config.json` (or the `AOC_TOKEN` env var). Once set, any request **not from loopback** must carry the token, one of three ways:
  - the `X-Gander-Token` header,
  - `?token=...` on the URL — use this for the **first load** from a browser; it sets a cookie so you don't need it again,
  - the `aoc_token` cookie (what the `?token=` load leaves behind).

  Requests from your own machine (loopback) are never challenged, so your local workflow is unchanged.

**Rule of thumb: ALWAYS set a token before flipping `allowRemote`.** A quick way to mint one:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Recommended: Tailscale

[Tailscale](https://tailscale.com) puts your PC and phone on a private, encrypted network — no ports opened to the internet, and it's free for personal use. This is the setup we recommend.

1. **Install Tailscale** on the PC running the bridge and on your phone, and sign both into the same tailnet.
2. Find your PC's tailnet address — the `100.x.y.z` IP from `tailscale ip -4`, or better, its **MagicDNS name** (e.g. `my-pc.tailnet-name.ts.net`).
3. In `bridge/aoc-config.json`, set both keys, then restart the bridge:

   ```json
   { "allowRemote": true, "accessToken": "your-long-random-string" }
   ```

4. On the phone, open:

   ```
   http://my-pc.tailnet-name.ts.net:3131/?token=your-long-random-string
   ```

   The `?token=` is only needed once — it sets the cookie.
5. **Add to home screen** (steps below). Thanks to the PWA manifest it installs as a real app — its own icon, standalone window, live floor in your pocket.

## Alternative: cloudflared quick tunnel

No accounts on the phone, works from any network:

```powershell
cloudflared tunnel --url http://localhost:3131
```

It prints a `https://<random>.trycloudflare.com` URL — open that on your phone (with `?token=...` on first load).

**Caveats, read them:** that URL is **public internet** — anyone who has it can reach your bridge, so the access token is **MANDATORY**, not optional. And the URL **rotates every run**, so you'll re-add the home-screen app (or re-enter the token) each time. Fine for a day out; use Tailscale for the permanent setup.

## Add to home screen

- **Android (Chrome):** open the dashboard → **⋮ menu → Add to Home screen** (or **Install app**) → **Install**. It launches standalone with the Gander icon.
- **iOS (Safari):** open the dashboard → **Share** (the square-with-arrow) → **Add to Home Screen** → **Add**. Must be Safari — other iOS browsers can't install PWAs.

## FAQ

**Why not just port-forward 3131 on my router?**
Don't. That exposes a tool that can run commands on your PC to the whole internet, guarded by one string. Tailscale gives you the same convenience with real encryption and device auth.

**Does the phone get push notifications?**
Use the built-in **Telegram alerts** for that — the bridge pings you when a session needs you, and you can reply or `/stop` right from the chat (see the README's Telegram section). The PWA is the other half: the **live floor** in your pocket, where you can read any agent's thread, reply, and **Allow / Deny** permission prompts.

**My phone connects but the tiles never load.**
The dashboard streams over a WebSocket to the same host/port — if the page loads, the socket should too. Check that you kept the `?token=` on the very first load (the cookie is what authorizes the socket), and that the bridge was restarted after editing `aoc-config.json`.
