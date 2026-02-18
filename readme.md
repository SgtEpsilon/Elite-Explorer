# Elite-Explorer

## Overview
Elite-Explorer is a desktop application built with Electron designed to process and visualize Elite:
Dangerous journal data. It allows commanders to analyze exploration activity, store data locally,
and interact with exploration insights through a modern UI.
Features
• Process and analyze Elite: Dangerous journal files
• Electron-based desktop UI
• Local SQLite database (explorer.db) for persistent storage
• Incremental journal tracking via lastProcessed.json
• Configurable behavior through config.json
Project Structure
.github/ GitHub workflows and automation
engine/ Core logic and processing engine
ui/ User interface components
config.json Application configuration
explorer.db Local SQLite database
main.js Electron main process
preload.js Secure bridge between UI and main process
index.js Application entry point
package.json Node/Electron dependencies

#Installation
`git clone https://github.com/SgtEpsilon/Elite-Explorer.git`
`cd Elite-Explorer`
`npm install`
`npm start`

## Quickstart Guide
1 Clone the repository and install dependencies using npm install.
2 Open config.json and set your Elite Dangerous journal directory path.
3 Run npm start to launch the Electron application.
4 Allow the app to process journal files automatically.
5 Explore processed data via the UI interface.
Usage Notes

The application stores processed exploration data in explorer.db. The lastProcessed.json file
ensures journals are not reprocessed unnecessarily. Modify config.json to change behavior such as
journal paths or data settings.