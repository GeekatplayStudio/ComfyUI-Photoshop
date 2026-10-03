/*
 * Geekatplay Photoshop Bridge - panel settings and registered workflows
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 *
 * Stored as settings.json in the plugin data folder. A registered workflow keeps a
 * snapshot of the workflow plus where it came from - a persistent token to a file, a
 * ComfyUI template name or a path in ComfyUI's workflows folder - so edits are picked up
 * on the next run and the snapshot covers a source that is gone.
 */
const { storage } = require("uxp");
const comfy = require("./comfy.js");
const { parseWorkflow } = require("./workflow.js");

const fs = storage.localFileSystem;
const SETTINGS_FILE = "settings.json";

const DEFAULTS = {
    server: "http://127.0.0.1:8188",
    maxEdge: 0,
    placeResults: true,
    randomizeSeed: true,
    allParams: false,
    workflows: [],
    targets: {},   // workflow id -> { sources: { image node id -> source }, prompt: node id } chosen by the user
    params: {},    // workflow id -> { "node id/input": value } edited under Settings
};

async function loadSettings() {
    const folder = await fs.getDataFolder();
    let entry;
    try {
        entry = await folder.getEntry(SETTINGS_FILE);
    } catch {
        return { ...DEFAULTS, workflows: [], targets: {}, params: {} };
    }
    return { ...DEFAULTS, workflows: [], targets: {}, params: {}, ...JSON.parse(await entry.read()) };
}

async function saveSettings(settings) {
    const file = await (await fs.getDataFolder()).createFile(SETTINGS_FILE, { overwrite: true });
    await file.write(JSON.stringify(settings, null, 2));
}

function newId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* Opens the file picker; returns the new registry entry, or null when the picker was cancelled. */
async function pickWorkflow() {
    const file = await fs.getFileForOpening({ types: ["json"] });
    if (!file) return null;
    const workflow = parseWorkflow(await file.read());
    return { id: newId(), kind: "file", name: file.name.replace(/\.json$/i, ""), path: file.nativePath, token: await fs.createPersistentToken(file), workflow };
}

/* Registry entry for a ComfyUI template (kind "template", path = template name) or a workflow saved in ComfyUI (kind "server", path in its workflows folder). */
function serverWorkflow(kind, path, name, workflow) {
    return { id: newId(), kind, name, path, workflow };
}

/* Re-reads the registered workflow from its source. Returns false when only the stored snapshot is available. */
async function refreshWorkflow(entry) {
    try {
        if (entry.kind === "template") entry.workflow = await comfy.template(entry.path);
        else if (entry.kind === "server") entry.workflow = await comfy.userWorkflow(entry.path);
        else entry.workflow = parseWorkflow(await (await fs.getEntryForPersistentToken(entry.token)).read());
    } catch {
        return false;
    }
    return true;
}

module.exports = { loadSettings, saveSettings, pickWorkflow, serverWorkflow, refreshWorkflow };
