# Ops cheat sheet (VPS)

Commands only, no theory. Everything runs on the server, in `~/sillytavern-mp`.

## Update the project

```bash
cd ~/sillytavern-mp
git pull origin master
```

If git complains about a `package-lock.json` conflict (or any other file that wasn't tracked before), it's just in the way; delete it and pull again:
```bash
rm keeper/package-lock.json
git pull origin master
```

After updating, if `keeper/` or `server/` changed, update their dependencies and restart:
```bash
cd ~/sillytavern-mp/keeper && npm install --omit=dev --no-audit --no-fund
cd ~/sillytavern-mp/server && npm install --omit=dev --no-audit --no-fund
sudo systemctl restart sillytavern-mp tavern-keeper
```

## Restart / check status

```bash
sudo systemctl restart sillytavern-mp   # relay server
sudo systemctl restart tavern-keeper    # headless browser

sudo systemctl status sillytavern-mp
sudo systemctl status tavern-keeper
```

## Logs

```bash
journalctl -u sillytavern-mp -f    # server
journalctl -u tavern-keeper -f     # keeper (headless browser)
```
`Ctrl+C` to exit.

## Keeper: what it is and how to tell it's alive

Keeper keeps a headless tavern tab open 24/7 and watches the SillyTavern data folder. If you add a preset, character, or world through your own SSH tunnel, keeper reloads its tab automatically within a few seconds.

Check that watching is enabled:
```bash
journalctl -u tavern-keeper -n 30 --no-pager | grep watching
```
There should be a line like `[keeper] watching for ST data changes: ...` with a list of folders. If it's missing, see below.

The tavern data path is set via `ST_DATA_PATH`, found here:
```bash
cat /etc/systemd/system/tavern-keeper.service.d/override.conf
```

Change the path:
```bash
sudo tee /etc/systemd/system/tavern-keeper.service.d/override.conf <<'EOF'
[Service]
Environment=ST_DATA_PATH=/path/to/SillyTavern/data/default-user
EOF
sudo systemctl daemon-reload
sudo systemctl restart tavern-keeper
```

Find the tavern path if you forgot it:
```bash
find / -maxdepth 6 -type d -iname "SillyTavern" 2>/dev/null | grep -v sillytavern-mp
ls <result>/data     # the user folder is in there, usually default-user
```

## Common errors

| Log message | Cause | Fix |
|---|---|---|
| `error: ... untracked working tree files would be overwritten` on `git pull` | A file that wasn't in the repo before now exists in a new commit | `rm` that file and `git pull` again |
| `Error: Cannot find module 'xxx'` | Dependencies weren't updated after `git pull` | `npm install --omit=dev` in `keeper/` and/or `server/`, then restart |
| No `watching for ST data changes` line in keeper's log | `ST_DATA_PATH` isn't set, or points to the wrong place | see the "Keeper" section above |
| `ST_DATA_PATH is set but none of the expected subfolders exist there` | The path points past the user folder (e.g. at the tavern root) | it should end in `.../data/default-user`, not `.../SillyTavern` |
| Preset/character isn't picked up at all | Keeper wasn't restarted after the `git pull` that added the watcher | `sudo systemctl restart tavern-keeper`, then check for `watching for ST data changes` in the log |
