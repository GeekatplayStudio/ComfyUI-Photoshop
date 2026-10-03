/*
 * Geekatplay Photoshop Bridge - panel controller
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 */
const comfy = require("./comfy.js");
const layers = require("./layers.js");
const store = require("./store.js");
const { checkApiWorkflow, imageRoles, findTargets, resolveTargets, modelFiles, missingModels, workflowParams, prepareWorkflow, resultImages, historyError } = require("./workflow.js");
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
let lastModels = null;            // model files of the last workflow run from the panel
let placing = Promise.resolve();  // placements run one at a time
let shown = null;                 // the selected workflow as shown under Inputs and Settings: { entry, api, targets, params }
let catalog = null;               // ComfyUI's templates and saved workflows, loaded when the browser opens

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
    catalog = null;
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

/*
 * The workflow in API format with everything the panel reads from it: regular workflows are
 * converted with this server's node definitions and report the inputs their author exposed
 * and the roles of their Load Image nodes.
 */
async function apiWorkflow(workflow) {
    if (!isUiWorkflow(workflow)) {
        const defs = await comfy.nodeDefs([...new Set(Object.values(workflow).map((n) => n.class_type))]);
        return { prompt: workflow, skipped: [], exposed: [], defs, roles: {}, missing: [] };
    }
    const defs = await comfy.nodeDefs(uiNodeTypes(workflow));
    const converted = convertUiWorkflow(workflow, defs);
    checkApiWorkflow(converted.prompt);
    return { ...converted, defs, roles: imageRoles(workflow), missing: missingModels(workflow, defs) };
}

/* The user's edits under Settings, keyed "node id/input", typed like the inputs they replace. */
function paramValues(entry) {
    return settings.params[entry.id] ?? {};
}

async function runWorkflow() {
    const entry = selectedWorkflow();
    if (!entry) throw new Error("No workflow selected. Connect to ComfyUI for the built-in ones, or register one in Settings.");
    const fromSource = entry.id.startsWith("builtin:") ? true : await store.refreshWorkflow(entry);
    const { prompt: api, skipped, roles } = await apiWorkflow(entry.workflow);
    const targets = resolveTargets(api, settings.targets[entry.id], roles);
    const prompt = $("prompt").value.trim();
    if (prompt && !targets.prompt.length) {
        throw new Error("No node in this workflow takes the prompt. Add a Photoshop Prompt node in ComfyUI, choose a node under Inputs, or clear the prompt.");
    }

    // Each image slot gets its own layer; a layer used by two slots goes up once. The result
    // is placed over the first layer sent. Without any, the workflow generates into the
    // selection or canvas.
    const uploads = new Map();
    let target = null;
    for (const slot of targets.image) {
        if (slot.source === "keep") continue;
        if (!uploads.has(slot.source)) {
            const read = await layers.readSource(settings.maxEdge, slot.source);
            showMessage(`Sending ${read.name} (${read.width} x ${read.height})...`);
            const image = await comfy.uploadLayer(read.pixels, { width: read.width, height: read.height, components: read.components, name: read.name });
            uploads.set(slot.source, { image, target: read.target });
        }
        slot.image = uploads.get(slot.source).image;
        target ??= uploads.get(slot.source).target;
    }
    let size = null;
    if (!target) {
        if (!prompt && !targets.prompt.length) throw new Error("This workflow takes neither a layer nor a prompt.");
        const canvas = await layers.canvasTarget();
        target = canvas.target;
        size = canvas;
    }

    const workflow = prepareWorkflow(api, { prompt, targets, values: paramValues(entry), size, randomizeSeed: settings.randomizeSeed });
    // A workflow with other models than the last one starts with free memory.
    const models = modelFiles(workflow);
    if (lastModels !== null && models !== lastModels) {
        showMessage("Unloading the previous models...");
        await comfy.freeMemory();
    }
    lastModels = models;

    const id = comfy.newPromptId();
    const label = prompt ? `${entry.name}: ${prompt.slice(0, 40)}` : entry.name;
    ownPrompts.add(id);
    jobs.set(id, { label, target, workflow, missing: 0 });
    try {
        await comfy.queuePrompt(workflow, id);
    } catch (err) {
        jobs.delete(id);
        throw err;
    }
    if (entry.kind && fromSource) persist();
    const notes = [];
    if (!fromSource) notes.push(`used the saved copy because ${entry.path} could not be read`);
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

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function labelled(container, className, text, control) {
    const row = element("div", className);
    row.appendChild(element("sp-body", `${className.split("-")[0]}-label`, text)).setAttribute("size", "XS");
    row.appendChild(control);
    container.appendChild(row);
    return control;
}

const pretty = (text) => text.replace(/_/g, " ");

/* Where each image slot and the prompt come from, with a picker per slot. */
function renderInputs(found, targets) {
    const inputs = $("inputs");
    inputs.innerHTML = "";
    const names = layers.layerNames();
    const sources = [["active", "Selection or selected layer"]];
    for (let n = 1; n <= Math.max(2, targets.image.length); n++) sources.push([`selected:${n}`, `Selected layer ${n}`]);
    sources.push(["canvas", "Whole canvas"], ...names.map((name) => [`layer:${name}`, `Layer: ${name}`]), ["keep", "Keep the workflow's image"]);
    for (const slot of targets.image) {
        const select = labelled(inputs, "input-row", pretty(slot.role), document.createElement("select"));
        select.title = slot.label;
        fillSelect(select, sources, slot.source);
        select.addEventListener("change", () => chooseSource(slot.id, select.value));
    }

    const { candidates, auto } = found.prompt;
    const first = auto === null ? "Choose a node..." : auto.length ? `Auto: ${auto.map((c) => c.label).join(", ")}` : "Auto: none";
    const select = labelled(inputs, "input-row", "prompt", document.createElement("select"));
    fillSelect(select, [["", first], ...candidates.map((c) => [c.id, c.label])], settings.targets[shown.entry.id]?.prompt ?? "");
    select.addEventListener("change", () => choosePrompt(select.value));

    const sends = targets.image.filter((s) => s.source !== "keep").length;
    $("inputs-hint").textContent = sends
        ? `Each image comes from its source above; the result is placed over the first one. ${targets.image.length > 1 ? "Selected layers are used top to bottom." : ""}`
        : "Generates an image from the prompt into the selection or canvas.";
}

function chooseSource(nodeId, source) {
    const id = shown.entry.id;
    settings.targets[id] = { ...settings.targets[id], sources: { ...settings.targets[id]?.sources, [nodeId]: source } };
    persist();
    showWorkflow().catch(report);
}

function choosePrompt(nodeId) {
    const id = shown.entry.id;
    settings.targets[id] = { ...settings.targets[id], prompt: nodeId };
    persist();
    showWorkflow().catch(report);
}

/* One control per editable input, grouped by the node or subgraph it belongs to. */
function renderParams(params) {
    const box = $("params");
    box.innerHTML = "";
    const values = paramValues(shown.entry);
    let group;
    for (const p of params) {
        if (p.group !== group) {
            group = p.group;
            if (group) box.appendChild(element("sp-detail", "param-group", group));
        }
        const path = `${p.id}/${p.key}`;
        const value = path in values ? values[path] : p.value;
        let control;
        if (p.type === "BOOLEAN") {
            control = element("sp-checkbox", "param-row", pretty(p.label));
            control.checked = !!value;
            control.addEventListener("change", () => setParam(p, control.checked));
            box.appendChild(control);
            continue;
        }
        if (p.type === "COMBO") {
            control = document.createElement("select");
            const options = p.options.includes(value) ? p.options : [value, ...p.options];
            fillSelect(control, options.map((o) => [String(o), String(o)]), String(value));
        } else if (p.type === "STRING" && p.multiline) {
            control = document.createElement("sp-textarea");
            control.value = value ?? "";
        } else {
            control = document.createElement("sp-textfield");
            if (p.type !== "STRING") control.setAttribute("type", "number");
            control.value = String(value ?? "");
        }
        control.addEventListener("change", () => setParam(p, control.value));
        labelled(box, "param-row", pretty(p.label), control).title = `${p.label} - ${p.id}`;
    }
    if (!params.length) box.appendChild(element("sp-body", "hint", shown ? "This workflow has no settings the panel can edit." : "")).setAttribute("size", "XS");
    $("reset-params").disabled = !Object.keys(values).length;
}

function setParam(p, raw) {
    let value = raw;
    if (p.type === "INT") value = Math.round(Number(raw));
    else if (p.type === "FLOAT") value = Number(raw);
    if (typeof value === "number") {
        if (Number.isNaN(value)) return;
        if (p.min !== undefined) value = Math.max(p.min, value);
        if (p.max !== undefined) value = Math.min(p.max, value);
    }
    const id = shown.entry.id;
    settings.params[id] = { ...settings.params[id], [`${p.id}/${p.key}`]: value };
    persist();
    $("reset-params").disabled = false;
}

function resetParams() {
    if (!shown) return;
    delete settings.params[shown.entry.id];
    persist();
    renderParams(shown.params);
}

/* Fills Inputs and Settings for the selected workflow. */
async function showWorkflow() {
    const entry = selectedWorkflow();
    shown = null;
    $("inputs").innerHTML = "";
    $("params").innerHTML = "";
    $("inputs-hint").textContent = "";
    $("workflow-info").className = "hidden";
    $("copy-models").className = "hidden";
    if (!entry || lastSeq === null) {
        $("inputs-hint").textContent = entry ? "Connect to ComfyUI to see the inputs and settings." : "";
        return;
    }
    let api;
    try {
        api = await apiWorkflow(entry.workflow);
    } catch (err) {
        $("inputs-hint").textContent = err.message;
        return;
    }
    if (selectedWorkflow() !== entry) return;
    let targets;
    try {
        targets = resolveTargets(api.prompt, settings.targets[entry.id], api.roles);
    } catch (err) {
        // Several prompt nodes: show the pickers so the user can choose.
        targets = { image: [], prompt: [], found: findTargets(api.prompt, api.roles) };
        $("inputs-hint").textContent = err.message;
    }
    const params = workflowParams(api.prompt, api.defs, api.exposed, targets, settings.allParams);
    shown = { entry, api, targets, params };
    renderInputs(targets.found, targets);
    renderParams(params);
    if (api.missing.length) {
        $("workflow-info").textContent = `Missing models: ${api.missing.map((m) => m.name).join(", ")}. Put them in the models folder ComfyUI expects${api.missing[0].directory ? ` (${[...new Set(api.missing.map((m) => m.directory))].join(", ")})` : ""}.`;
        $("workflow-info").className = "error";
        $("copy-models").className = "";
    }
}

async function copyModelLinks() {
    const lines = (shown?.api.missing ?? []).map((m) => `${m.name}${m.directory ? `  (models/${m.directory})` : ""}\n${m.url ?? ""}`);
    await navigator.clipboard.setContent({ "text/plain": lines.join("\n\n") });
    showMessage("Copied the download links.");
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
    delete settings.targets[removed.id];
    delete settings.params[removed.id];
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
        row.title = entry.kind === "template" ? `ComfyUI template ${entry.path}` : entry.kind === "server" ? `ComfyUI workflows/${entry.path}` : entry.path;
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
    showWorkflow().catch(report);
}

function registerWorkflow(entry) {
    settings.workflows.push(entry);
    persist();
    renderWorkflows();
    $("workflow-select").value = entry.id;
    showWorkflow().catch(report);
    showMessage(`Registered ${entry.name}.`);
}

async function addWorkflow() {
    const entry = await store.pickWorkflow();
    if (!entry) return;
    if (settings.workflows.some((w) => w.path === entry.path)) throw new Error(`${entry.path} is already registered.`);
    registerWorkflow(entry);
}

/* ComfyUI's image templates that run locally, and the workflows saved in ComfyUI. */
async function loadCatalog() {
    if (lastSeq === null) throw new Error("Connect to ComfyUI first.");
    const [templates, saved] = await Promise.all([comfy.templates(), comfy.userWorkflows()]);
    const makesImage = (t) => (t.io?.outputs ? t.io.outputs.some((o) => o.mediaType === "image") : t.mediaType === "image");
    const items = templates.filter((t) => t.openSource && makesImage(t)).map((t) => ({
        kind: "template",
        path: t.name,
        title: t.title ?? t.name,
        detail: [t.category, ...(t.tags ?? []).filter((tag) => tag !== t.category), ...(t.models ?? [])].join(" · "),
        images: (t.io?.inputs ?? []).filter((i) => i.mediaType === "image").length,
    }));
    for (const path of saved) items.push({ kind: "server", path, title: path.replace(/\.json$/i, ""), detail: "Saved in ComfyUI", images: null });
    return items;
}

function renderCatalog() {
    const list = $("browse-list");
    list.innerHTML = "";
    const words = $("browse-search").value.toLowerCase().split(/\s+/).filter(Boolean);
    const shownItems = catalog.filter((item) => words.every((w) => `${item.title} ${item.detail}`.toLowerCase().includes(w)));
    for (const item of shownItems.slice(0, 200)) {
        const row = element("div", "browse-row");
        const text = element("div", "grow");
        text.appendChild(element("sp-body", "", item.title)).setAttribute("size", "S");
        const inputs = item.images === null ? "" : item.images ? ` · ${item.images} image input${item.images > 1 ? "s" : ""}` : " · prompt only";
        text.appendChild(element("sp-detail", "", item.detail + inputs));
        row.appendChild(text);
        const registered = settings.workflows.some((w) => w.kind === item.kind && w.path === item.path);
        row.appendChild(smallButton(registered ? "Added" : "Add", registered ? null : () => addCatalogItem(item).catch(report)));
        list.appendChild(row);
    }
    if (!shownItems.length) list.appendChild(element("sp-body", "hint", "Nothing matches.")).setAttribute("size", "XS");
    else if (shownItems.length > 200) list.appendChild(element("sp-body", "hint", `${shownItems.length - 200} more - narrow the search.`)).setAttribute("size", "XS");
}

async function addCatalogItem(item) {
    const workflow = item.kind === "template" ? await comfy.template(item.path) : await comfy.userWorkflow(item.path);
    if (!isUiWorkflow(workflow)) checkApiWorkflow(workflow);
    registerWorkflow(store.serverWorkflow(item.kind, item.path, item.title, workflow));
    renderCatalog();
}

async function toggleBrowse() {
    const panel = $("browse-panel");
    if (panel.className === "browse-panel") {
        panel.className = "browse-panel hidden";
        return;
    }
    catalog ??= await loadCatalog();
    panel.className = "browse-panel";
    renderCatalog();
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
    $("all-params").checked = settings.allParams;
    renderWorkflows();

    for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showPage(tab));
    action("send-active", sendToActiveWorkflow);
    action("run", runWorkflow);
    action("cancel", cancelJobs);
    action("copy-message", copyMessage);
    action("copy-models", copyModelLinks);
    action("add-workflow", addWorkflow);
    action("browse", toggleBrowse);
    action("reset-params", async () => resetParams());
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
    $("all-params").addEventListener("change", () => {
        settings.allParams = $("all-params").checked;
        persist();
        showWorkflow().catch(report);
    });
    $("workflow-select").addEventListener("change", () => showWorkflow().catch(report));
    $("browse-search").addEventListener("input", () => catalog && renderCatalog());

    poll();
}

init().catch(report);
