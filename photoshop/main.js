/*
 * Geekatplay Photoshop Bridge - panel controller
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 */
const comfy = require("./comfy.js");
const layers = require("./layers.js");
const store = require("./store.js");
const { checkApiWorkflow, findTargets, resolveTargets, prepareWorkflow, resultImages, historyError } = require("./workflow.js");
const { isUiWorkflow, uiNodeTypes, convertUiWorkflow } = require("./convert.js");

const $ = (id) => document.getElementById(id);

let settings;
let outdated = false;             // the connected server runs older nodes without the built-in workflows
let builtin = [];                 // workflows shipped with the nodes, read from the connected server
let lastSeq = null;               // position in the server's result feed; null while disconnected
let lastState = { running: [], pending: [] };
const sentLayers = new Map();     // ComfyUI image name -> target, to place active-workflow results over their layer
const ownPrompts = new Set();     // prompts queued by this panel; their results are placed from /history
const jobs = new Map();           // prompt id -> { label, target, workflow, missing, note }
let placing = Promise.resolve();  // placements run one at a time

function showMessage(text, isError = false) {
    $("message").textContent = text;
    $("message").className = isError ? "error" : "";
    $("copy-message").className = text ? "" : "hidden";
}

/* UXP text cannot be selected, so the status and message are copied with a button. */
async function copyMessage() {
    const text = [...new Set([$("status-text").textContent, $("message").textContent])].filter(Boolean).join("\n");
    await navigator.clipboard.setContent({ "text/plain": text });
}

function report(err) {
    console.error(err);
    showMessage(err.message ?? String(err), true);
}

function persist() {
    store.saveSettings(settings).catch(report);
}

/* Runs a button action with the button disabled, reporting errors in the panel. */
function action(id, fn) {
    const button = $(id);
    button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
            await fn();
        } catch (err) {
            report(err);
        } finally {
            button.disabled = false;
        }
    });
}

function setConnection(ok, text) {
    $("status-dot").className = ok ? "dot ok" : "dot";
    $("status-text").textContent = text;
}

async function connect() {
    comfy.setServer(settings.server);
    try {
        const stats = await comfy.systemStats();
        lastSeq = (await comfy.state()).seq;
        try {
            builtin = Object.entries(await comfy.builtinWorkflows()).map(([name, workflow]) => ({ id: `builtin:${name}`, name, workflow }));
            outdated = false;
        } catch {
            // A ComfyUI started before the nodes were updated has the older routes only.
            builtin = [];
            outdated = true;
        }
        renderWorkflows();
        setConnection(true, `ComfyUI ${stats.system.comfyui_version} at ${settings.server}`);
    } catch (err) {
        lastSeq = null;
        setConnection(false, err.message);
    }
}

function placeAll(images, target, label) {
    images.forEach((image, i) => {
        const name = images.length > 1 ? `${label} ${i + 1}` : label;
        placing = placing.then(async () => {
            const bytes = await comfy.downloadImage(image);
            await layers.placeImage(bytes, image.filename, target, name);
            showMessage(`Placed "${name}".`);
        }).catch(report);
    });
}

function handleResult(result) {
    if (ownPrompts.has(result.prompt_id) || !settings.placeResults) return;
    const source = result.sources.find((name) => sentLayers.has(name));
    placeAll(result.images, source ? sentLayers.get(source) : null, "ComfyUI");
}

function showJobs(st) {
    const [id, job] = jobs.entries().next().value ?? [];
    if (!id) {
        $("progress").className = "hidden";
        return;
    }
    const more = jobs.size > 1 ? ` (+${jobs.size - 1} more)` : "";
    const progress = st.progress?.prompt_id === id ? st.progress : null;
    let text = `Waiting for ${job.label}`;
    if (st.running.includes(id)) text = progress ? `Running ${job.label}: step ${progress.value} of ${progress.max}` : `Running ${job.label}`;
    else if (st.pending.includes(id)) text = `${job.label} is queued at position ${st.pending.indexOf(id) + 1}`;
    $("progress").className = "";
    $("progress").value = progress ? Math.round((100 * progress.value) / progress.max) : 0;
    showMessage(text + more + (job.note ? ` (${job.note})` : ""));
}

async function finishJob(id, job) {
    let entry;
    try {
        entry = await comfy.history(id);
    } catch (err) {
        report(err);
        return;
    }
    if (!entry) {
        // Not running, not queued and not in history: it was deleted from the queue.
        if (++job.missing > 3) {
            jobs.delete(id);
            report(new Error(`${job.label} was removed from the ComfyUI queue.`));
        }
        return;
    }
    jobs.delete(id);
    const error = historyError(entry);
    if (error) return report(new Error(`${job.label}: ${error}`));
    const images = resultImages(job.workflow, entry);
    if (!images.length) return report(new Error(`${job.label} finished without an image to place.`));
    placeAll(images, job.target, job.label);
}

async function poll() {
    if (lastSeq === null) await connect();
    if (lastSeq !== null) {
        let st = null;
        try {
            st = await comfy.state(lastSeq);
        } catch (err) {
            lastSeq = null;
            setConnection(false, err.message);
        }
        if (st) {
            lastSeq = st.seq;
            lastState = st;
            st.results.forEach(handleResult);
            for (const [id, job] of jobs) {
                if (!st.running.includes(id) && !st.pending.includes(id)) await finishJob(id, job);
            }
            showJobs(st);
        }
    }
    setTimeout(poll, lastSeq === null ? 5000 : 1000);
}

async function sendToActiveWorkflow() {
    const layer = await layers.readSource(settings.maxEdge);
    showMessage(`Sending ${layer.width} x ${layer.height}...`);
    const image = await comfy.uploadLayer(layer.pixels, { width: layer.width, height: layer.height, components: layer.components, name: layer.name });
    await comfy.sendToOpenWorkflow(image, $("active-prompt").value.trim());
    sentLayers.set(image, layer.target);
    showMessage(`Sent "${layer.name}" (${layer.width} x ${layer.height}). Queue the workflow in ComfyUI.`);
}

function selectedWorkflow() {
    const id = $("workflow-select").value;
    return [...builtin, ...settings.workflows].find((w) => w.id === id);
}

/* The workflow in API format; regular workflows are converted with this server's node definitions. */
async function apiWorkflow(workflow) {
    if (!isUiWorkflow(workflow)) return { prompt: workflow, skipped: [] };
    const converted = convertUiWorkflow(workflow, await comfy.nodeDefs(uiNodeTypes(workflow)));
    checkApiWorkflow(converted.prompt);
    return converted;
}

async function runWorkflow() {
    const entry = selectedWorkflow();
    if (!entry) throw new Error("No workflow selected. Connect to ComfyUI for the built-in ones, or register one in Settings.");
    const fromFile = entry.token ? await store.refreshWorkflow(entry) : true;
    const { prompt: api, skipped } = await apiWorkflow(entry.workflow);
    const targets = resolveTargets(api, settings.targets[entry.id]);
    const prompt = $("prompt").value.trim();
    if (prompt && !targets.prompt.length) {
        throw new Error("No node in this workflow takes the prompt. Add a Photoshop Prompt node in ComfyUI, choose a node under Inputs, or clear the prompt.");
    }

    // A workflow with an image input edits the selection or layer; one without generates into the selection or canvas.
    let image = null;
    let source;
    if (targets.image.length) {
        source = await layers.readSource(settings.maxEdge);
        showMessage(`Sending ${source.width} x ${source.height}...`);
        image = await comfy.uploadLayer(source.pixels, { width: source.width, height: source.height, components: source.components, name: source.name });
    } else {
        if (!prompt && !targets.prompt.length) throw new Error("This workflow takes neither a layer nor a prompt.");
        source = await layers.canvasTarget();
    }

    const workflow = prepareWorkflow(api, { image, prompt, targets, size: image ? null : source, randomizeSeed: settings.randomizeSeed });
    const id = comfy.newPromptId();
    const label = prompt ? `${entry.name}: ${prompt.slice(0, 40)}` : entry.name;
    ownPrompts.add(id);
    jobs.set(id, { label, target: source.target, workflow, missing: 0 });
    try {
        await comfy.queuePrompt(workflow, id);
    } catch (err) {
        jobs.delete(id);
        throw err;
    }
    if (entry.token && fromFile) persist();
    const notes = [];
    if (!fromFile) notes.push(`used the saved copy because ${entry.path} could not be read`);
    if (skipped.length) notes.push(`left out nodes this server does not run: ${skipped.join(", ")}`);
    jobs.get(id).note = notes.join("; ");
    showMessage(`Queued ${entry.name}.`);
}

async function cancelJobs() {
    const queued = [...jobs.keys()].filter((id) => lastState.pending.includes(id));
    if (queued.length) await comfy.deleteQueued(queued);
    queued.forEach((id) => jobs.delete(id));
    for (const id of jobs.keys()) await comfy.interrupt(id);
    showMessage(jobs.size ? "Cancelling..." : "Cancelled.");
}

function fillSelect(select, options, value) {
    select.innerHTML = "";
    for (const [id, text] of options) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = text;
        select.appendChild(option);
    }
    // UXP leaves a rebuilt <select> blank until its value is set.
    select.value = options.some(([id]) => id === value) ? value : options[0]?.[0] ?? "";
}

/* Shows which nodes of the selected workflow receive the layer and the prompt, and lets the user choose. */
async function updateInputs() {
    const entry = selectedWorkflow();
    const hint = $("inputs-hint");
    for (const kind of ["image", "prompt"]) fillSelect($(`${kind}-target`), [], "");
    hint.textContent = "";
    if (!entry || lastSeq === null) return;
    let found;
    try {
        found = findTargets((await apiWorkflow(entry.workflow)).prompt);
    } catch (err) {
        hint.textContent = err.message;
        return;
    }
    if (selectedWorkflow() !== entry) return;
    const chosen = settings.targets[entry.id] ?? {};
    for (const kind of ["image", "prompt"]) {
        const { candidates, auto } = found[kind];
        const none = kind === "image" ? "none - generates from the prompt" : "none";
        const first = auto === null ? "Choose a node..." : auto.length ? `Auto: ${auto.map((c) => c.label).join(", ")}` : `Auto: ${none}`;
        fillSelect($(`${kind}-target`), [["", first], ...candidates.map((c) => [c.id, c.label])], chosen[kind] ?? "");
    }
    hint.textContent = found.image.auto?.length === 0 && !chosen.image
        ? "Generates an image from the prompt into the selection or canvas."
        : "Sends the selection, or the selected layer when nothing is selected.";
}

function chooseTarget(kind) {
    const entry = selectedWorkflow();
    if (!entry) return;
    settings.targets[entry.id] = { ...settings.targets[entry.id], [kind]: $(`${kind}-target`).value };
    persist();
    updateInputs().catch(report);
}

function smallButton(label, onClick) {
    const button = document.createElement("sp-action-button");
    button.setAttribute("quiet", "");
    button.textContent = label;
    if (onClick) button.addEventListener("click", onClick);
    else button.disabled = true;
    return button;
}

function moveWorkflow(index, offset) {
    const list = settings.workflows;
    [list[index], list[index + offset]] = [list[index + offset], list[index]];
    persist();
    renderWorkflows();
}

function removeWorkflow(index) {
    const [removed] = settings.workflows.splice(index, 1);
    persist();
    renderWorkflows();
    showMessage(`Removed ${removed.name}.`);
}

function renderWorkflows() {
    const list = $("workflow-list");
    list.innerHTML = "";
    settings.workflows.forEach((entry, i) => {
        const row = document.createElement("div");
        row.className = "workflow-row";
        row.title = entry.path;
        const name = document.createElement("sp-textfield");
        name.value = entry.name;
        name.addEventListener("change", () => {
            entry.name = name.value.trim() || entry.name;
            persist();
            renderWorkflows();
        });
        row.appendChild(name);
        row.appendChild(smallButton("↑", i > 0 ? () => moveWorkflow(i, -1) : null));
        row.appendChild(smallButton("↓", i < settings.workflows.length - 1 ? () => moveWorkflow(i, 1) : null));
        row.appendChild(smallButton("✕", () => removeWorkflow(i)));
        list.appendChild(row);
    });
    if (!settings.workflows.length) list.textContent = "No workflows registered yet.";

    const all = [...builtin, ...settings.workflows];
    fillSelect($("workflow-select"), all.map((w) => [w.id, w.name]), $("workflow-select").value);
    $("builtin-count").textContent = builtin.length ? `${builtin.length} built-in workflows come from the ComfyUI server.` : "";
    $("workflows-note").textContent = outdated ? "Restart ComfyUI to load the built-in workflows: it is running an older version of the Photoshop Bridge nodes." : "";
    $("workflows-note").className = outdated ? "error" : "hidden";
    updateInputs().catch(report);
}

async function addWorkflow() {
    const entry = await store.pickWorkflow();
    if (!entry) return;
    if (settings.workflows.some((w) => w.path === entry.path)) throw new Error(`${entry.path} is already registered.`);
    settings.workflows.push(entry);
    persist();
    renderWorkflows();
    $("workflow-select").value = entry.id;
    updateInputs().catch(report);
    showMessage(`Registered ${entry.name}.`);
}

function showPage(tab) {
    for (const t of document.querySelectorAll(".tab")) {
        t.className = t === tab ? "tab selected" : "tab";
        $(t.getAttribute("data-page")).className = t === tab ? "page" : "page hidden";
    }
}

async function init() {
    settings = await store.loadSettings();

    $("server").value = settings.server;
    $("max-edge").value = String(settings.maxEdge);
    $("place-results").checked = settings.placeResults;
    $("randomize-seed").checked = settings.randomizeSeed;
    renderWorkflows();

    for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showPage(tab));
    action("send-active", sendToActiveWorkflow);
    action("run", runWorkflow);
    action("cancel", cancelJobs);
    action("copy-message", copyMessage);
    action("add-workflow", addWorkflow);
    action("connect", async () => {
        settings.server = $("server").value.trim() || "http://127.0.0.1:8188";
        $("server").value = settings.server;
        persist();
        await connect();
    });
    $("max-edge").addEventListener("change", () => {
        settings.maxEdge = Math.max(0, parseInt($("max-edge").value, 10) || 0);
        $("max-edge").value = String(settings.maxEdge);
        persist();
    });
    $("place-results").addEventListener("change", () => {
        settings.placeResults = $("place-results").checked;
        persist();
    });
    $("randomize-seed").addEventListener("change", () => {
        settings.randomizeSeed = $("randomize-seed").checked;
        persist();
    });
    $("workflow-select").addEventListener("change", () => updateInputs().catch(report));
    $("image-target").addEventListener("change", () => chooseTarget("image"));
    $("prompt-target").addEventListener("change", () => chooseTarget("prompt"));

    poll();
}

init().catch(report);
