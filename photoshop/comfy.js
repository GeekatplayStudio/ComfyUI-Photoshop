/*
 * Geekatplay Photoshop Bridge - ComfyUI HTTP client
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 */
const { promptError } = require("./workflow.js");

let base = "http://127.0.0.1:8188";
// Jobs queued from the panel carry their own client id so ComfyUI does not stream their
// node outputs into the browser tab, where they would land on unrelated nodes.
const clientId = `photoshop-${Date.now().toString(36)}`;
const defs = new Map(); // node class -> /object_info entry

function setServer(address) {
    base = address.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
}

function query(params) {
    return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

async function send(path, init) {
    try {
        return await fetch(base + path, init);
    } catch (err) {
        throw new Error(`Cannot reach ComfyUI at ${base} (${err.message}).`);
    }
}

async function request(path, init = {}) {
    const res = await send(path, init);
    const text = await res.text();
    let body = text;
    try {
        body = JSON.parse(text);
    } catch {
        // aiohttp error pages are plain text
    }
    // Without the nodes, GET gives 404 and POST falls through to the static handler, which gives 405.
    if ((res.status === 404 || res.status === 405) && path.startsWith("/geekatplay/")) {
        throw new Error("ComfyUI is running but the Geekatplay Photoshop Bridge nodes are not loaded. Install them and restart ComfyUI.");
    }
    if (res.status === 413) {
        throw new Error("The layer is larger than the ComfyUI upload limit. Lower 'Max size sent' in Settings or start ComfyUI with --max-upload-size.");
    }
    if (!res.ok) throw new Error(path === "/prompt" ? promptError(body) : `ComfyUI error ${res.status}: ${body?.error ?? text}`);
    return body;
}

function postJson(path, data) {
    return request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

function systemStats() {
    defs.clear();
    return request("/system_stats");
}

/* Node definitions for the given class names; unknown classes are left out. Cached until the next connect. */
async function nodeDefs(types) {
    const found = await Promise.all(types.map(async (type) => {
        if (!defs.has(type)) defs.set(type, await request(`/object_info/${encodeURIComponent(type)}`));
        return defs.get(type);
    }));
    return Object.assign({}, ...found);
}

/* ComfyUI's template catalog as one list, each template with its category title. */
async function templates() {
    const index = await request("/templates/index.json");
    return index.flatMap((category) => category.templates.map((t) => ({ ...t, category: category.title })));
}

function template(name) {
    return request(`/templates/${encodeURIComponent(name)}.json`);
}

/* Paths of the workflows saved in ComfyUI (Workflow > Save), relative to its workflows folder. */
function userWorkflows() {
    return request("/api/userdata?dir=workflows&recurse=true");
}

function userWorkflow(path) {
    return request(`/api/userdata/${encodeURIComponent(`workflows/${path}`)}`);
}

/* `pixels` is 8-bit chunky RGB or RGBA. Returns the ComfyUI image name, e.g. "photoshop/Layer 1_20261002-101500.png". */
async function uploadLayer(pixels, { width, height, components, name }) {
    const body = await request(`/geekatplay/photoshop/upload?${query({ width, height, components, name })}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: pixels.byteLength === pixels.buffer.byteLength ? pixels.buffer : pixels.slice().buffer,
    });
    return body.image;
}

/* Switches the Photoshop Image (and, with a prompt, Photoshop Prompt) nodes of the workflow open in ComfyUI. */
function sendToOpenWorkflow(image, prompt) {
    return postJson("/geekatplay/photoshop/send", { image, prompt });
}

/* The workflows shipped with the nodes, by name. */
function builtinWorkflows() {
    return request("/geekatplay/photoshop/workflows");
}

function state(after) {
    return request(after === undefined ? "/geekatplay/photoshop/state" : `/geekatplay/photoshop/state?after=${after}`);
}

function queuePrompt(prompt, promptId) {
    return postJson("/prompt", { prompt, prompt_id: promptId, client_id: clientId });
}

async function history(promptId) {
    const body = await request(`/history/${promptId}`);
    return body[promptId] ?? null;
}

function interrupt(promptId) {
    return postJson("/interrupt", { prompt_id: promptId });
}

/*
 * Unloads all models and clears ComfyUI's node cache. ComfyUI applies this between queue
 * items, so wait until an idle server has done it before queueing the next workflow.
 */
async function freeMemory() {
    await postJson("/free", { unload_models: true, free_memory: true });
    for (let i = 0; i < 40; i++) {
        const st = await state();
        if (!st.freeing || st.running.length) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

function deleteQueued(promptIds) {
    return postJson("/queue", { delete: promptIds });
}

async function downloadImage({ filename, subfolder, type }) {
    const res = await send(`/view?${query({ filename, subfolder: subfolder ?? "", type: type ?? "output" })}`);
    if (!res.ok) throw new Error(`Could not download ${filename} from ComfyUI (${res.status}).`);
    return res.arrayBuffer();
}

/* ComfyUI accepts client-chosen prompt ids in canonical UUID form. */
function newPromptId() {
    const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
    hex[12] = "4";
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const s = hex.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

module.exports = { setServer, systemStats, nodeDefs, templates, template, userWorkflows, userWorkflow, uploadLayer, sendToOpenWorkflow, builtinWorkflows, state, queuePrompt, history, interrupt, freeMemory, deleteQueued, downloadImage, newPromptId };
