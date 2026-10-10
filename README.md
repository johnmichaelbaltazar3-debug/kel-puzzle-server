# Kel Puzzle V2 Rank Match — Server Deployment

## Important
The app cannot match players on real phones while `rank_server_url` points to `10.0.2.2`. That address only works for an Android emulator. This package deliberately uses a placeholder URL until the server is deployed; it does **not** pretend the online service is live yet.

## Deploy the WebSocket server to Render
1. Upload/push the complete `KelPuzzleV2` project to a GitHub repository.
2. In Render, choose **New + → Blueprint** and select that repository. Render will read `render.yaml`.
3. Wait for the `kel-puzzle-ranked` service to deploy. Open `https://YOUR-SERVICE.onrender.com/health`; it should return JSON with `ok: true`.
4. Copy the actual Render hostname. In `app/src/main/res/values/strings.xml`, replace `wss://YOUR-RENDER-SERVICE.onrender.com` with `wss://ACTUAL-HOSTNAME.onrender.com` (no trailing slash).
5. Rebuild and install the same APK on both phones. Both devices must have internet access.
6. Open Ranked Arena on both phones and tap **Find Online Match**. Keep both apps open while testing.

## Local server
From this directory: `cd server`, `npm install`, `npm start`. Health endpoint is `http://localhost:8080/health`. For a phone on the same Wi-Fi, use the computer's LAN IP with `ws://LAN-IP:8080` only for testing, and ensure the firewall allows port 8080. Do not use `10.0.2.2` on a physical phone.

## Notes
- Render's ephemeral filesystem may reset `server/data/players.json` after restarts/redeploys. Use a persistent disk or database before relying on persistent ranked accounts.
- This server relays client-submitted scores; it is not cheat-proof. Add authoritative puzzle-move validation before a public competitive launch.
- The server must be deployed before the app can connect. A ZIP or successful Android build alone cannot create a public server automatically.
