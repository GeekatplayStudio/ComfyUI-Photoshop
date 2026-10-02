/*
 * Geekatplay Photoshop Bridge - panel settings and registered workflows
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 *
 * Stored as settings.json in the plugin data folder. Registered workflows keep a
 * snapshot of the API workflow plus a persistent token to the file, so edits to the
 * file are picked up on the next run and the snapshot covers a moved file.
 */
const { storage } = require("uxp");
const { parseWorkflow } = require("./workflow.js");

const fs = storage.localFileSystem;
const SETTINGS_FILE = "settings.json";

const DEFAULTS = {
    server: "http://127.0.0.1:8188",
    maxEdge: 0,
    placeResults: true,
    randomizeSeed: true,
    workflows: [],
    targets: {},   // workflow id -> { image, prompt } node ids chosen by the user
};

async function loadSettings() {
    const folder = await fs.getDataFolder();
    let entry;
    try {
        entry = await folder.getEntry(SETTINGS_FILE);
    } catch {
        return { ...DEFAULTS, workflows: [], targets: {} };
    }
    return { ...DEFAULTS, ...JSON.parse(await entry.read()) };
}

async function saveSettings(settings) {
    const file = await (await fs.getDataFolder()).createFile(SETTINGS_FILE, { overwrite: true });
    await file.write(JSON.stringify(settings, null, 2));
}

/* Opens the file picker; returns the new registry entry, or null when the picker was cancelled. */
async function pickWorkflow() {
    const file = await fs.getFileForOpening({ types: ["json"] });
    if (!file) return null;
    const workflow = parseWorkflow(await file.read());
    return {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: file.name.replace(/\.json$/i, ""),
        path: file.nativePath,
        token: await fs.createPersistentToken(file),
        workflow,
    };
}

/* Re-reads the registered file. Returns false when only the stored snapshot is available. */
async function refreshWorkflow(entry) {
    let text;
    try {
        text = await (await fs.getEntryForPersistentToken(entry.token)).read();
    } catch {
        return false;
    }
    entry.workflow = parseWorkflow(text);
    return true;
}

module.exports = { loadSettings, saveSettings, pickWorkflow, refreshWorkflow };
