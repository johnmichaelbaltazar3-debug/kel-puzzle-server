# Kel Puzzle Ranked Server Update

Use these files to update the GitHub repository connected to the existing Render service.

1. Replace the repository-root `server.js` with this `server.js`.
2. Keep/replace `package.json` with the included one.
3. Commit both files to the branch Render deploys (normally `main`).
4. Wait until Render shows the new deploy as live.
5. Verify `https://kel-puzzle-server.onrender.com/health` returns JSON with `"ok":true`.

The root page `/` is expected to say `Not found`; use `/health` for the health check. The Android client URL should be `wss://kel-puzzle-server.onrender.com`.
