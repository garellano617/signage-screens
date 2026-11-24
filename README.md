# Signage Screens

Two parts:

- **`portal/`**: website to manage TV screens. Pair TVs with a code, upload images, videos and web pages, build playlists, set schedules, rotate screens, take live screenshots and send remote commands.
- **`player-android/`**: the **Signage Player** Android app for TVs, Android TV boxes and tablets (Android 5.0+). It shows a pairing code, downloads content for offline playback, follows schedules, starts on boot and restarts itself after a crash.

## Clients

Every screen, playlist and media file belongs to a **client** (a business you put screens in).

- **Main portal (your team):** **Dashboard** (all clients at a glance, plus offline screens), **Clients** (add, edit, pause or delete clients, with an optional screen limit) and **Settings** (your team's logins, the player app, your password).
- **Inside a client:** open a client to get its own menu: **Overview, Screens, Playlists, Media, Logins**. Use **← All clients** to go back. Each client has its own address (`#/c/<id>/...`), so you can bookmark it.
- **A client's own logins** land straight in their account, with the same menu and no way out to other clients. A client admin can add more logins for their business. Clients can't upload the player app.
- **Pausing** a client logs their users out and blocks their logins. Their TVs keep playing.
- A client can only be deleted after their screens are removed. Deleting a client also deletes their playlists, media and logins.

## Menu

**Your team (main level):** Dashboard (all clients, offline screens) · White Label & Clients · Screen Monitoring · Reports · Billing · Download App · Profile & Admins.

**Inside a client (and a client's own login):** Dashboard · Wizard · Content (Media library, Widgets) · Channels · Playlists · Screens · Screen Monitoring · Reports · Billing · Logins (or Download App and Profile & Admins for a client's login).

- **Wizard:** step by step: add content → make a playlist → connect a TV → design layers.
- **Widgets:** clock, weather (Open-Meteo, no key), news feed (RSS/Atom), QR code, countdown, message. Add them to playlists like images. The same drawing code runs in the portal and on the TV.
- **Channels:** one playlist + layers design shared by many screens. Each screen's own schedule still applies.
- **Screen Monitoring:** online now, uptime per hour (24 hours, 7 days), screenshot wall, "screenshot all".
- **Reports (proof of play):** the player reports every item it played. Plays and time per day, per content, per screen. CSV export. Kept 13 months.
- **White label:** portal name, logo (PNG/JPG/WebP) and main color, shown on the login page, the menu and the browser tab.
- **Billing:** reads each client's plan, monthly amount and paid/overdue status from the Premier Signage Billing app (read-only). Set `BILLING_URL` and `BILLING_KEY` here, and the same key as `SIGNAGE_INTEGRATION_KEY` in the billing app. Then link each client on the Billing page.

## Screen layers

Each screen is designed as four layers, stacked bottom to top. Open a screen and click **Design layers**. The editor has a live preview, and the TV draws the layers with the same code (`portal/public/overlay/`, bundled into the APK at build time).

1. **Video:** the screen's playlist and schedule. It can fill the screen or a smaller area (left 70%, top 85%, …) to leave room for the other layers.
2. **Specials:** offers with title, price, description and an optional photo, taking turns every few seconds. Each one can be limited to certain days and times. Shown as a side panel or a card.
3. **Text:** text blocks in any of 9 positions (size, colors, box), plus a scrolling ticker at the top or bottom. When a ticker is on, other layers move out of its way.
4. **Effects:** an animated overlay: snow, confetti, sparkles, bubbles, hearts, falling leaves or twinkling stars.

Each layer has an on/off switch. Specials photos are downloaded to the TV with the rest of the media, so layers work offline.

## Run the portal on this PC

Double-click `portal\start-portal.cmd`, then open http://localhost:3100.

- On first start it creates the login `admin@example.com` and prints a random password in the window. Change it in **Settings**.
- To set your own login on first start, set the `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables before starting.
- All data (database, uploads, screenshots, the APK) is stored in `portal\data\`. Back up that folder.
- TVs on your network connect to `http://<this PC's IP>:3100`. If Windows Firewall asks, allow Node.js on **private networks**.

Tests: `cd portal` then `npm test`.

## Put the portal online (Render)

The repository includes a Render Blueprint (`render.yaml`). It runs the portal on the **Starter** plan (about $7/month) with a **10 GB disk** (about $2.50/month) at `/data`, which holds the database, uploads, screenshots and the APK.

1. Push this repository to GitHub. A private repository is fine.
2. In Render, go to **New → Blueprint**, connect GitHub, and pick the repository.
3. Enter `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the first admin login, then click **Apply**.
4. Own domain: the portal's address is **https://signage.precom.net** (listed under `domains` in `render.yaml`; if it doesn't show up under the service's **Settings → Custom Domains**, add it there). At Network Solutions, the DNS for `precom.net` has a **CNAME** record: host `signage`, pointing to `signage-portal.onrender.com`. Render sets up HTTPS automatically once the record is live. The old `signage-portal.onrender.com` address keeps working.
5. Log in, open **Settings**, and upload the player APK.

**Can't log in?** In Render, go to **Environment** and check `ADMIN_EMAIL` and `ADMIN_PASSWORD`. To reset the password to `ADMIN_PASSWORD`, add `ADMIN_RESET_PASSWORD` = `true`, save (the service restarts), log in, then delete `ADMIN_RESET_PASSWORD`.

Every push to `main` that changes `portal/` redeploys automatically. The disk keeps your data across deploys.

## Build the player app

Double-click `player-android\build-apk.cmd`.

- The first run asks you to accept Google's Android SDK license, then installs the SDK pieces.
- Java and the Android SDK live in `C:\Users\servi\android-build`. Nothing is installed system-wide.
- The finished APK is copied into the portal, so **Settings → Download player app** serves it.
- Recommended: `build-apk.cmd https://signage.precom.net` builds the portal address into the app, so TVs skip the address screen.
- To sign with your own key instead of the debug key, create `player-android\keystore.properties` with `storeFile`, `storePassword`, `keyAlias` and `keyPassword`.

## Set up a TV

1. Install the APK. You may need to allow installing from unknown sources.
2. Open **Signage Player** and enter the portal address.
3. The TV shows a 6-character code. In the portal, go to **Screens → Add screen** and enter it.
4. On the TV remote, press **BACK three times** (or long-press on touch screens) for the menu: change the portal address, turn on kiosk mode (use as home screen), allow auto-start, or exit.

## How the player talks to the portal

- `POST /api/player/register` returns a device token and the pairing code.
- `POST /api/player/heartbeat` runs every 30 s (every 5 s while unpaired). It sends status and returns the config version and any pending commands.
- `GET /api/player/config` returns the playlists and schedules. Media is downloaded from `/media/...` and checked with SHA-256.
- `POST /api/player/screenshot` uploads a JPEG.

Schedule days are a bitmask, with bit 0 = Monday. A slot that ends before it starts (for example 22:00–06:00) runs overnight.
