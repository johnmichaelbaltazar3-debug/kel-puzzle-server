# Kel Puzzle V2 — Rank Match server

## Current production endpoint

The Android project is configured for the Render service that was tested during setup:

- Health check: `https://kel-puzzle-server.onrender.com/health`
- WebSocket URL used by the app: `wss://kel-puzzle-server.onrender.com`

The health endpoint should return JSON with `"ok":true`. A `Not found` response at the service root `/` is expected; use `/health` to check the server.

## Update the server already connected to Render

The Render service in the user's setup is connected to a GitHub repository whose files are in the repository root (`server.js`, `package.json`, and `README.md`). Render will not automatically deploy this project's `server/server.js` unless that root file is updated.

1. Open the GitHub repository connected to Render.
2. Replace the repository-root `server.js` with the contents of this project's `server/server.js`.
3. Keep the repository-root `package.json` with the `ws` dependency and `start` script (`node server.js`).
4. Commit the change to the branch Render deploys (previously `main`).
5. Wait for Render to finish deploying, then open `https://kel-puzzle-server.onrender.com/health` and confirm `ok:true`.

The companion archive `KelPuzzleV2_RankMatch_Server_Update.zip` contains the correct root-level `server.js`, `package.json`, and README for that GitHub repository.

## Update the Android app

The Android client code has also changed. Build a new APK from this project and install the same new APK on both phones. The existing `rank_server_url` is already set to `wss://kel-puzzle-server.onrender.com`; do not use `10.0.2.2` on physical phones.

## Local server

From this directory: `npm install`, then `npm start`. The health endpoint is `http://localhost:8080/health`.

## Important limitations

- Render free instances can sleep after inactivity, so the first connection after idle may take 50 seconds or longer. Keep both apps open while testing.
- This server stores player data in `server/data/players.json`. Render's free filesystem is ephemeral; player records may be lost after a restart or redeploy. Use a persistent database before a public launch.
- The server now coordinates the official start timestamp, validates timeout claims, stores final results for reconnect recovery, and settles no-moves results once. Puzzle state is still submitted by the clients, so this is not fully cheat-proof for a public competitive launch.
- I could not run the Android Gradle build in this environment because Gradle 9.6.1 could not be downloaded without network access. Build and test the generated APK in JStudio/Android Studio before distributing it.

## Rank-match protocol notes

- A match is created only from two different player IDs with two currently open WebSocket connections. Rank and KP are not queue filters.
- `match_found` only establishes the pairing. Both clients must acknowledge `intro_ready`; the server then broadcasts one shared `intro_start` timestamp. Both clients must finish the approximately 8-second intro and send `ready` before the server emits one shared `battle_start` (`startAt`/`endsAt`).
- `progress`, `ready`, and `finished` messages are bound to the active `matchId` and current socket. Progress sequence numbers, monotonic scores, snapshot dimensions, and slot values are checked. Duplicate terminal messages cannot apply rewards twice.
- `no_moves` is treated as a loss declaration by the sender, not a client-declared win. The server still cannot prove every puzzle move from aggregate score/board snapshots; a server-side move replay engine and authenticated identities are required for strong anti-cheat protection.
- If two devices use the same player ID, the second live connection is rejected. Use separate accounts/player IDs for two-phone PvP tests.
- `players.json` is a local JSON persistence fallback. Render's ephemeral filesystem can lose it on restart/redeploy; do not assume production KP/history is durable without a persistent store. No paid database is added by this patch.
