# Premier Signage (Android)

The TV app. Build it on this PC with `build-apk.cmd`, or let GitHub build it: every push that changes this folder
runs `.github/workflows/player-app.yml`, which builds, signs and publishes the app to the portal. TVs then update
themselves (see the main README, "Automatic player updates").

To publish a new build by hand, run the "Player app" workflow from GitHub → Actions.

Builds are signed with the same key as the app already on the TVs (kept in the PLAYER_KEYSTORE_B64 secret).

Updates reach the TVs within a minute of a build being published.
