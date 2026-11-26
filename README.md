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

**Inside a client (and a client's own login):** Dashboard · Wizard · Content (Media library, Widgets) · Channels · Video walls · Playlists · Screens · Screen Monitoring · Reports · Billing · Logins (or Download App and Profile & Admins for a client's login).

- **Wizard:** step by step: add content → make a playlist → connect a TV → design layers.
- **Widgets:** clock, weather (Open-Meteo, no key), news feed (RSS/Atom), QR code, countdown, message. Add them to playlists like images. The same drawing code runs in the portal and on the TV.
- **Save as template:** in the designer's Templates tab, "Save this design as a template" keeps the current layers (text, pictures, specials, effects, timing) under **My templates** for that client. Staff can tick "Share with all clients": it shows under **Shared templates** for everyone, without the client's pictures. Saved templates have a × to delete them (screens that used one keep their design). Up to 100 per client.
- **Text and picture effects:** Glow, Neon glow (with a gentle flicker), Shadow, Shine (a light sweeps across; on pictures it stays inside the picture's shape) and Grow (a gentle pulse), each with its own color. The Text tab also has "Neon sign" and "Glowing heading" presets.
- **Timeline rows and transitions:** texts and pictures can share a timeline row and take turns (drag a bar up or down onto another row, or onto "+ New row"). Where two bars on a row overlap, the overlap is the transition (a crossfade unless another one is picked). Each text or picture has an entrance and an exit: fade, small → big, big → small, slide from/to the left, right, top or bottom, spin, pop; 0.3 to 3 seconds. In the Media tab, with a picture selected, clicking another picture adds it after the selected one in the same spot and row (a 5-second slideshow with 1-second crossfades).
- **Select several and lock as a group:** Ctrl/Shift-click bars on any timeline rows (on a phone: tap "☐ Select several", then tap the bars). With 2 or more selected: drag one bar to move them all, drag an end to stretch them all by the same amount, "Same start" / "Same end" to line them up, or "🔒 Lock as group" to keep them together (locked bars show 🔒 and a colored border; tapping one selects the whole group). Stored per block as `grp` (0 = no group).
- **Effects:** snow, confetti, sparkles, bubbles, hearts, leaves, stars, plus animated scenes: Santa & reindeer (flies by every 15 s to 5 min, optional snow), fireworks, shooting stars, balloons, and a **plane pulling a banner** (your text up to 60 characters and/or a small logo picture from Media, banner and text colors, flies by every 15 s to 5 min). The Templates tab has "Santa's sleigh" and "Plane with banner" designs.
- **Channels:** one playlist + layers design shared by many screens. Each screen's own schedule still applies.
- **Video walls:** one big picture or video across several TVs hung next to each other (up to 6 × 6). Choose the grid, the playlist and which screen hangs in each spot. Each TV shows only its part, and all play in step using the portal's clock (heartbeats carry `serverTime`; videos keep correcting their speed to stay together). Settings: **Fill** (crop to fill the wall) or **Fit** (whole picture), and the gap between screens (% of a screen's width) so the picture lines up across the TV frames. Pictures and videos only (web pages and widgets are skipped), no layers, and sound only from the top-left screen. While in a wall, a screen's own playlist, channel, schedule and layers are not used. Needs the player app from the video walls update (it reaches the TVs on its own). **Wall effects** (on the wall's page): an animation on top of the wall that moves across all its screens, drawn from the shared clock so each TV draws its own part. Templates: Santa & reindeer (sleigh flies across every screen, with snow), Plane with banner (your message or logo pulled across every screen), New Year fireworks, Starry night (shooting stars), Party balloons, Snow storm, Confetti party, Valentine hearts, Autumn leaves.
- **Screen Monitoring:** online now, uptime per hour (24 hours, 7 days), screenshot wall, "screenshot all".
- **Reports (proof of play):** the player reports every item it played. Plays and time per day, per content, per screen. CSV export. Kept 13 months.
- **White label:** portal name, logo (PNG/JPG/WebP) and main color, shown on the login page, the menu and the browser tab.
- **Billing:** reads each client's plan, monthly amount and paid/overdue status from the Premier Signage Billing app (read-only). Set `BILLING_URL` and `BILLING_KEY` here, and the same key as `SIGNAGE_INTEGRATION_KEY` in the billing app. Then link each client on the Billing page.

## Screen layers

Each screen is designed as four layers, stacked bottom to top. Open a screen and click **Design layers**. The TV draws the layers with the same code as the editor's preview (`portal/public/overlay/`, bundled into the APK at build time).

The editor works like a video editor:
- **Toolbar** (top): settings for whatever is selected: font, size, bold, italic, alignment, colors, box, width, snap to a spot, bring forward / send backward, duplicate, delete.
- **Side panel** (left): **Media** (click a picture to place it), **Text** (heading, subheading, body text, price list, label, plus the scrolling ticker), **Specials**, **Effects**, **Video**.
- **Preview** (middle): drag text and pictures anywhere. Click the video area to select the video layer.
- **Timeline** (bottom): one track per layer with an on/off box. Text and picture bars can be moved and resized to set when they show. Play, or click the ruler to jump to a moment. The **timeline length** is how often timed text and pictures repeat on the TV.
- **Delete** key removes the selected text or picture.
- **Templates** tab: 12 ready-made designs to start from (menu board, daily deal, price list, coffee shop, happy hour, grand opening, big sale, new arrivals, welcome lobby, holiday, Valentine's Day, fall harvest). A blank screen opens on this tab. Applying one replaces the design; **Undo** brings the old one back until you save.
- **✨ AI** tab: describe the screen ("Taco Tuesday, 3 tacos and a drink for $7.99, festive") and Claude designs it, using the client's name and pictures. **Write new words, keep my layout** only rewrites the text (for example to change the offer or translate it). Nothing is saved until you click Save. The AI only uses prices you give it.

### Turn on the AI designer

The AI tab calls the Anthropic API (model `claude-opus-5-5`), which is billed to your Anthropic account per request (usually a few cents).

1. Create an API key at console.anthropic.com (add billing there).
2. In Render, open **signage-portal → Environment** and add `ANTHROPIC_API_KEY` with that key. The service restarts.
3. Optional: `AI_DAILY_LIMIT` sets how many AI requests each client can make per day (default 40).

Without the key, the AI tab shows how to turn it on, and the templates still work.

### AI help (the Help button)

Every page has a **? Help** button (bottom right; a full-height panel on phones). People ask in their own words how to do something in the portal or the TV app, and Claude answers from the user guide in `portal/src/helpGuide.md`, knowing which page they are on and whether they are staff or a client. It suggests questions for the current page and keeps the chat while moving between pages (until the browser tab is closed).

- Uses the same `ANTHROPIC_API_KEY`. Each question is billed to the Anthropic account (the guide is cached, so repeat questions cost less; check console.anthropic.com for actual usage). `AI_HELP_DAILY_LIMIT` sets questions per login per day (default 50).
- **Keep the guide current:** when a feature changes, update `portal/src/helpGuide.md`. The assistant only answers from it and says when it isn't sure.

1. **Video:** the screen's playlist and schedule. It can fill the screen or a smaller area (left 70%, top 85%, …) to leave room for the other layers.
2. **Specials:** offers with title, price, description and an optional photo, taking turns every few seconds. Each one can be limited to certain days and times. Shown as a side panel or a card.
3. **Text & pictures:** text in any of 5 fonts (system fonts, so they work offline) and pictures (logos, food photos, price boards) placed anywhere, each shown all the time or only part of each cycle. Plus a scrolling ticker at the top or bottom; text snapped to a top or bottom spot moves out of its way.
4. **Effects:** an animated overlay: snow, confetti, sparkles, bubbles, hearts, falling leaves or twinkling stars.

Specials photos and pictures on the text layer are downloaded to the TV with the rest of the media, so layers work offline.

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
- To sign with your own key instead of the debug key, create `player-android\keystore.properties` with `storeFile`, `storePassword`, `keyAlias` and `keyPassword`. Don't switch keys once TVs are installed: Android only accepts updates signed with the same key, so every TV would need the app removed and installed again.

### Automatic player updates

TVs keep their app up to date on their own (app 1.2 and later). Each check-in, the portal tells the TV which APK is current (by its SHA-256 fingerprint). If the TV's own app differs, it downloads the new one, checks it and installs it, then the player restarts. The portal's screen page shows the progress under **App updates**.

- **Who presses Install:** on most boxes Android asks once per update ("Do you want to install this update?"), and someone presses **Install** with the remote. The first update may also ask to allow **Install unknown apps** for Signage Player. For updates with no prompt at all, make the player the device owner once, on a freshly reset box with no Google account, from a PC with adb: `adb shell dpm set-device-owner com.signage.player/.AdminReceiver`.
- **Safety:** Android only installs a build signed with the same key and with a higher version number. Every build gets a higher number automatically. A file that can't install is not tried again.
- **Publishing a build:** uploading an APK under **Settings → Download player app** publishes it to every TV. The GitHub workflow `.github/workflows/player-app.yml` does this automatically: whenever player code is pushed to `main`, GitHub builds the app and uploads it to the portal. It needs two secrets in GitHub (**Settings → Secrets and variables → Actions**): `PLAYER_KEYSTORE_B64` (the signing key, base64) and `PLAYER_UPLOAD_KEY`. The same `PLAYER_UPLOAD_KEY` (at least 32 characters) goes in Render → signage-portal → Environment. Without that setting, the upload address is off.

## Set up a TV

1. Install the APK. You may need to allow installing from unknown sources.
2. Open **Signage Player** and enter the portal address.
3. The TV shows a 6-character code. In the portal, go to **Screens → Add screen** and enter it.
   - **Set up before the TV is installed:** in **Add screen**, choose **Set up now, connect the TV later**. Give the screen a name, then pick its playlist and schedule and design its layers. It shows **No TV yet** (not counted as offline). When the TV is installed, open the screen and click **Connect TV** (or pick it under **Connect it to** in **Add screen**) and type the TV's code. The TV plays the prepared design right away. Prepared screens count toward the client's screen limit.
   - **Replace a TV:** on the screen's page, click **Replace TV** and type the new TV's code. It takes over the screen's playlist, schedule and layers, and the old TV goes back to showing a code.
4. On the TV remote, press **BACK three times** (or long-press on touch screens) for the menu: change the portal address, turn on kiosk mode (use as home screen), allow auto-start, or exit.

## How the player talks to the portal

- `POST /api/player/register` returns a device token and the pairing code.
- `POST /api/player/heartbeat` runs every 30 s (every 5 s while unpaired). It sends status and returns the config version and any pending commands.
- `GET /api/player/config` returns the playlists and schedules. Media is downloaded from `/media/...` and checked with SHA-256.
- `POST /api/player/screenshot` uploads a JPEG.

Schedule days are a bitmask, with bit 0 = Monday. A slot that ends before it starts (for example 22:00–06:00) runs overnight.
