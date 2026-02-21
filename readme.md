![Open Bugs](https://img.shields.io/github/issues-search/SgtEpsilon/Elite-Explorer?query=is%3Aissue+is%3Aopen+label%3Abug&label=open%20bugs&color=red) ![Open Enhancements](https://img.shields.io/github/issues-search/SgtEpsilon/Elite-Explorer?query=is%3Aissue+is%3Aopen+label%3Aenhancement&label=open%20enhancements&color=blue&style=flat)

# Elite-Explorer

Elite-Explorer is a desktop application built with Electron that processes and visualizes journal data from Elite: Dangerous. It gives commanders a local-first tool to monitor their current session in real time, track exploration history, sync with third-party services, and plan future routes -- all without relying on any external cloud backend. Your data is stored locally and stays on your machine.

A community Discord is available at [[FGS] Lazy Songbird Discord](https://discord.gg/yDqcXVZ3MH).

---

## Table of Contents

- [Features](#features)
- [Download](#download)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Interface Overview](#interface-overview)
- [Third-Party Integrations](#third-party-integrations)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [Contributing](#contributing)
- [Support the Project](#support-the-project)
- [License](#license)

---

## Features

- Live session monitoring -- current system, ship stats, fuel, hull, credits, and docked station details update in real time as you play
- System bodies panel populated immediately on system entry via EDSM, without waiting for the Discovery Scanner to fire
- First-discovery detection with visual indicators for systems you found first
- Full exploration history built from your journal files, searchable and sortable, with optional EDSM flight log sync to fill in gaps
- Commander profile showing ranks, superpower reputation, and lifetime statistics
- EDSM integration for live system information (security, allegiance, economy, population) and flight log merging
- EDDN relay to contribute your live journal data to the Elite Dangerous Data Network
- Local SQLite database for persistent storage -- all processed data survives between sessions
- Incremental journal processing so startup stays fast regardless of how large your journal history grows
- Configurable UI with theme options, panel layout controls, opacity, and scaling

---

## Download

Pre-built binaries for Windows are available on the [GitHub Releases](https://github.com/SgtEpsilon/Elite-Explorer/releases) page. Two options are provided:

**Installer (`setup.exe`)** -- Runs a standard Windows installer that sets up Elite-Explorer on your system, creates a desktop shortcut and Start Menu entry, and handles uninstallation cleanly through Windows Settings. Recommended if you want Elite-Explorer to behave like a regular installed application.

**No-Install Version (`.exe`)** -- A self-contained executable that runs directly without any installation step. Nothing is written to Program Files or the registry. Place it wherever you like and run it. Suitable if you prefer to keep the app portable or run it from a specific folder.

Both versions are functionally identical. The choice comes down to personal preference.

---

## Prerequisites

The pre-built `.exe` files have no external dependencies -- Node.js is bundled inside the Electron executable. Simply download and run.

If you intend to run from source, you will need:

- **Node.js** v18 or later -- [nodejs.org](https://nodejs.org)
- **npm** (bundled with Node.js)

In either case, **Elite: Dangerous** must be installed with journal logging enabled. Journals are generated automatically by the game during play and are typically found at:

`C:\Users\<YourName>\Saved Games\Frontier Developments\Elite Dangerous`

---

## Installation

There are three ways to get Elite-Explorer running. Choose whichever suits you best.

### Option 1 -- Installer

Download `setup.exe` from the [Releases page](https://github.com/SgtEpsilon/Elite-Explorer/releases) and run it. Follow the on-screen prompts. Once complete, Elite-Explorer will appear in your Start Menu and on your desktop, and can be uninstalled through Windows Settings like any other application.

### Option 2 -- No-Install Version

Download the standalone `.exe` from the [Releases page](https://github.com/SgtEpsilon/Elite-Explorer/releases). No installation is required. Place the file wherever you want to run it from and double-click to launch.

### Option 3 -- Run from Source

Clone the repository and install dependencies:

```bash
git clone https://github.com/SgtEpsilon/Elite-Explorer.git
cd Elite-Explorer
npm install
```

Then launch with:

```bash
npm start
```

This option is best suited for developers or anyone who wants to modify the application.

---

## Quickstart

### Step 1 -- Launch the application

Open Elite-Explorer using whichever method you installed -- via the Start Menu or desktop shortcut, by double-clicking the no-install `.exe`, or by running `npm start` from the source directory.

On first launch, Elite-Explorer will automatically locate your Elite: Dangerous journal directory. On most Windows systems this succeeds without any input required. If your journals are not found automatically, you can set the path at any time through the Options panel inside the app -- no manual file editing is needed.

### Step 2 -- Let the app process your journals

Once the journal directory is confirmed, Elite-Explorer scans and processes your journal files in the background. Your exploration history is built from all FSDJump entries across every journal. Depending on how many journals you have, this initial scan may take a moment. A progress indicator is shown during the scan.

### Step 3 -- Launch Elite: Dangerous and play

With the app running alongside the game, the Live tab updates in real time as you jump between systems, scan bodies, dock at stations, and move through the galaxy. No additional setup is needed for live tracking.

### Step 4 -- Subsequent launches

On future launches, Elite-Explorer picks up where it left off. Only new or unprocessed journal entries are imported, keeping startup fast regardless of how large your journal history grows.

---

## Interface Overview

Elite-Explorer is organized into four tabs accessible from the top navigation bar.

### Live

The main view during active play. Displays real-time data pulled directly from your journal as events occur:

- **Commander panel** -- current system, coordinates, security, allegiance, economy, population, and a link to view the system on EDSM
- **Ship panel** -- ship name, type, identifier, jump range, cargo capacity, fuel level with a visual bar, hull integrity, and rebuy cost
- **Station panel** -- name, type, and controlling faction of the station you are currently docked at
- **Credits** -- your current credit balance, updated live
- **System Bodies panel** -- all bodies in the current system, populated immediately on arrival using EDSM data rather than waiting for your Discovery Scanner
- **Scan summary** -- running count of stars, planets, moons, and total bodies scanned in the current session
- **FSS progress bar** -- shows Discovery Scanner completion percentage for the current system
- **EDDN and EDSM status indicators** -- small dots in the top bar show whether each integration is active

### Profile

Commander identity and statistics:

- Current system with first-discovery badge if applicable
- Commander ranks across all Elite: Dangerous disciplines
- Superpower reputation standings
- Lifetime statistics pulled from your journal

### History

A full searchable and sortable table of every system you have jumped to, built from your local journal files. Supports merging with your EDSM flight log to fill in any gaps from sessions before Elite-Explorer was installed. A rescan button allows you to rebuild the history from scratch if needed.

### Options

Accessible from the gear icon in the top bar on any page. Options include:

- Setting or changing the journal folder path, with a browse button and a shortcut to open the folder in Windows Explorer
- Rescanning all journals or refreshing profile data manually
- EDSM commander name and API key for flight log sync and discovery checking
- EDDN toggle to enable or disable contributing data to the network
- Theme selection
- UI scaling, panel width controls, and opacity

---

## Third-Party Integrations

### EDSM (Elite Dangerous Star Map)

Elite-Explorer connects to EDSM for two purposes. First, system bodies are fetched automatically on every FSD jump and populated in the System Bodies panel immediately, without requiring you to use the Discovery Scanner. Second, if you provide your EDSM commander name and API key in Options, the app can sync your full EDSM flight log and merge it with your local history, filling in jumps from sessions that predate Elite-Explorer.

EDSM system information (security, allegiance, economy, population) is also displayed in the Live tab when the EDSM integration is enabled.

Your EDSM API key can be found at [edsm.net](https://www.edsm.net) under your account settings.

### EDDN (Elite Dangerous Data Network)

When enabled in Options, Elite-Explorer relays your live journal events to EDDN, contributing to the community-maintained database of exploration data. Only schema-compliant events are submitted and all personal or private fields are stripped before submission.

---

## Project Structure

```
Elite-Explorer/
├── .github/                        GitHub workflows and automation
├── engine/
│   ├── api/
│   │   └── server.js               Local REST API server (port 3721)
│   ├── core/
│   │   ├── engine.js               Core event listeners -- writes scan and location events to the database
│   │   └── eventBus.js             Internal pub/sub bus connecting journal events to consumers
│   ├── db/
│   │   ├── database.js             SQLite database wrapper (sql.js)
│   │   └── schema.sql              Database schema -- personal_scans and commander_state tables
│   ├── providers/
│   │   ├── journalProvider.js      Reads and tails the live journal file in real time
│   │   ├── journalWatcher.js       File watcher using chokidar for live journal updates
│   │   ├── journalWorker.js        Worker thread for processing individual journal entries
│   │   ├── historyProvider.js      Scans all journal files for FSDJump history
│   │   └── historyWorker.js        Worker thread for history scanning
│   └── services/
│       ├── capiService.js          Frontier Companion API integration (in progress)
│       ├── eddnRelay.js            EDDN submission relay
│       ├── edsmClient.js           EDSM system info and bodies fetching
│       └── edsmSyncService.js      EDSM flight log sync and local history merging
├── ui/
│   ├── index.html                  Live tab
│   ├── profile.html                Profile tab
│   ├── history.html                History tab
│   ├── spansh.html                 Spansh route planner tab (in progress)
│   ├── elite-dashboard.html        Dashboard view
│   ├── script.js                   Main UI logic
│   ├── history-script.js           History tab logic
│   ├── spansh-script.js            Spansh tab logic (in progress)
│   └── styles.css                  Application stylesheet
├── config.json                     Application configuration (managed by the app)
├── explorer.db                     Local SQLite database
├── lastProcessed.json              Tracks journal processing state for incremental updates
├── main.js                         Electron main process -- window, IPC, app lifecycle
├── preload.js                      Secure context bridge between main process and renderer
├── index.js                        Application entry point
└── package.json                    Node.js dependencies and build configuration
```

---

## How It Works

When Elite-Explorer starts, `main.js` initializes the Electron window and brings up every service in sequence. The journal provider reads and tails the current journal file in real time using chokidar, emitting events onto an internal event bus as new entries appear. The history provider spawns a worker thread that reads all past journal files for FSDJump entries and builds the full history independently without blocking the UI.

The EDSM client listens on the event bus for location events and fetches system bodies and info on every jump, pushing results to the renderer immediately. The EDDN relay also listens on the event bus and submits qualifying events to the EDDN network when enabled.

The renderer communicates with the main process exclusively through the IPC bridge defined in `preload.js`, using Electron's context isolation. The renderer never has direct access to the file system, database, or Node.js APIs. When you navigate between tabs, each page fires a load event and the main process replays the latest cached data so information appears immediately without rescanning.

All exploration data is persisted in `explorer.db`, a local SQLite database powered by sql.js. The `lastProcessed.json` file records the state of journal processing so that only new entries are read on subsequent launches.

---

## Contributing

Contributions are welcome and appreciated. Whether you want to fix a bug, add a feature, improve the UI, or extend the journal parsing engine, here is how to get involved.

### Getting Started

Fork the repository on GitHub and clone your fork locally:

```bash
git clone https://github.com/<your-username>/Elite-Explorer.git
cd Elite-Explorer
npm install
```

Create a new branch for your changes with a descriptive name:

```bash
git checkout -b feature/my-new-feature
```

### Development Workflow

The project is split into two main concerns -- the `engine/` directory handles all data processing and service integrations, and the `ui/` directory contains everything the user sees. Try to keep changes focused and avoid mixing unrelated modifications in a single pull request.

When working on the engine, be mindful that journal parsing must remain robust against malformed or incomplete entries. Elite: Dangerous journals are written live while the game runs, and partial writes at the end of a file are possible.

When working on service integrations (EDSM, EDDN), consult the official API documentation and respect rate limits. The EDSM sync service deliberately introduces delays between batch requests to stay within the 360 requests/hour limit.

Run the application during development with:

```bash
npm start
```

To build distributable binaries:

```bash
npm run build:win    # Windows installer + portable exe
npm run build:mac    # macOS DMG
npm run build:linux  # AppImage + deb
```

### Submitting a Pull Request

When your changes are ready:

1. Commit your changes with a clear, descriptive commit message.
2. Push your branch to your fork.
3. Open a pull request against the `main` branch of this repository.
4. In the pull request description, explain what the change does, why it is needed, and any relevant context or caveats.

Please keep pull requests focused. Large, sweeping changes are harder to review and slower to merge. If you are planning something significant, consider opening an issue first to discuss the approach.

### Reporting Issues

If you encounter a bug, please open an issue on GitHub and include the following where possible:

- Your operating system and version
- Your Node.js version (if running from source)
- A description of the problem and steps to reproduce it
- Any relevant output from the terminal or Electron developer tools (accessible via Ctrl+Shift+I)

### Code Style

Follow the existing code style in whichever part of the project you are editing. Consistency with surrounding code is more important than any particular convention. Keep things simple and readable.

### Community

Discussions, questions, and ideas are welcome on the [[FGS] Lazy Songbird Discord](https://discord.gg/yDqcXVZ3MH)

---

## Support the Project

If you find Elite-Explorer useful and want to support its continued development:

- Patreon: [patreon.com/RogueMandoGaming](https://patreon.com/RogueMandoGaming)
- Ko-fi: [ko-fi.com/sgtepsilon](https://ko-fi.com/sgtepsilon)

---

## License

Elite-Explorer is released under the [MIT License](LICENSE). You are free to use, modify, and distribute this software in accordance with the terms of that license.
