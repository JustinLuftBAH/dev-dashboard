# Dev Dashboard

A lightweight Electron app for managing local development services (databases, APIs, UIs,
tunnels, etc.) from one place. Start/stop services, switch run profiles with a flag toggle,
copy launch commands, open links, and watch status at a glance.

## Features

- **Service cards** grouped into categories — start/stop/restart, live status.
- **Flag toggle** — pick a value (e.g. a Spring profile) that gets substituted into the start
  command via `{{flag}}`, so one service can target different environments.
- **Copy command** — copy a service's full, working terminal command to run it yourself.
- **Links** — one or more links per service (open in your browser).
- **Process match** — distinguish services that share a port (status won't get confused).
- **Custom running color** — per-service hue shown when it's on.
- **Appearance** — theme accent, background, and text colors; background star animation
  toggle + speed; reset-appearance and wipe-all-services buttons.
- **Uptime timers** — each running service shows how long it's been up (H:MM).
- **Drag to reorder** — drag service cards and sidebar categories into any order.
- **Shortcuts** — group several services behind one start/stop button.

## Download (no install)

Just want to *use* the dashboard? Grab the prebuilt app — no Node.js, npm, or Electron
needed:

1. Go to the [**Releases** page](https://github.com/JustinLuftBAH/dev-dashboard/releases).
2. Download `Dashboard-mac-arm64.zip` and unzip it.
3. First launch: **right-click `Dashboard.app` → Open** (it's unsigned, so macOS needs a
   one-time approval).

> For macOS on Apple Silicon. If you want to **modify/iterate** the dashboard, run from
> source instead (below).

## Quick launch (`dashboardgui` command)

Set up a `dashboardgui` terminal command so you can open the app from anywhere.

First, make sure you have **Node.js 18** installed (`node -v`). If not, install it
(e.g. `brew install node@18`).

Then, from the repo folder, run these three commands **one at a time**:

```bash
npm install
./scripts/install.sh
source ~/.zshrc
```

`npm install` pulls in Electron (first time only), `install.sh` registers the
`dashboardgui` command (no sudo), and `source ~/.zshrc` loads it into your current shell
(or just open a new terminal).

Then just run:

```bash
dashboardgui
```

It opens the packaged `Dashboard.app` if you've built one, otherwise it runs from source
(detached, so your terminal stays free) and prints its log to `dashboard.log` if anything
goes wrong. The installer adds a `dashboardgui` alias to your shell rc file — re-running it
is safe.

> **Tip:** run the setup commands individually, not as one pasted block. Some shells don't
> treat `#` as a comment interactively, which can turn a pasted comment into a bad argument.

### Slow or stuck Electron download

`npm install` downloads a ~100MB Electron binary the first time. On a slow or proxied
network this can crawl or stall. To skip the download, get the
`electron-v<version>-darwin-arm64.zip` file from a teammate who already has it (it lives in
`~/Library/Caches/electron/<hash>/` on their machine), drop it in your `~/Downloads`, then:

```bash
bash scripts/seed-electron.sh
npm install
```

`seed-electron.sh` finds the zip in `~/Downloads` (or `~/Desktop`), figures out the correct
cache location automatically, and copies it there so `npm install` uses it instead of
downloading. `dashboardgui` also does this automatically if it finds a matching zip in your
Downloads/Desktop.

## Requirements

- **macOS** (built/tested on Apple Silicon).
- **Node.js 18** recommended (newer majors may work; 18 is known-good).
- Electron is installed as a dev dependency.

## Run from source

```bash
npm install
npm start
```

> Running from source shows the name "Electron" in the Dock. That's expected for dev mode.

## Build a standalone app (.app)

```bash
npm run dist
```

Output: `dist/mac-arm64/Dashboard.app`. Drag it into `/Applications`. The packaged app shows
the proper "Dashboard" name and icon.

> `electron-builder` may require a newer Node major than 18 to package. If `npm run dist`
> fails on Node 18, switch to a newer Node and retry.

## Configuration

Your services/categories live in a per-user config file (not in this repo):

```
~/Library/Application Support/Dashboard/config.json
```

The app starts blank — add your own categories and services from the UI (or edit the JSON via
**Settings → Config File → Open**). Because config is per-user, your personal services are
never committed; everyone customizes their own.

## Project layout

```
main/          Electron main process (main.js) + preload.js  — service control, IPC
renderer/      UI: index.html, css/app.css, js/app.js
icon.png       App icon (source)
icon.icns      App icon (packaged builds)
package.json   Scripts + electron-builder config
```

## Contributing / iterating

1. Clone the repo.
2. `npm install`
3. `npm start` to run from source; edit files under `main/` and `renderer/`.
   - Renderer (HTML/CSS/JS) changes: reload the window (Cmd+R).
   - Main process (`main/main.js`) changes: quit and `npm start` again.
4. Open a PR / push a branch to share changes.
