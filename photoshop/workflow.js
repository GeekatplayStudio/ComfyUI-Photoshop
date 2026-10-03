/*
 * Geekatplay Photoshop Bridge - workflow handling
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 *
 * Pure functions over ComfyUI workflows (no Photoshop APIs), so they run under
 * node for tests. Registered files can be API workflows or regular saved
 * workflows; regular ones are converted with convert.js before each run.
 */
const { isUiWorkflow } = require("./convert.js");

const IMAGE_NODE = "GeekatplayPhotoshopImage";
const PROMPT_NODE = "GeekatplayPhotoshopPrompt";
const SIZE_NODE = "GeekatplayPhotoshopSize";
const OUTPUT_NODE = "GeekatplaySendToPhotoshop";
const PLACEABLE = /\.(png|jpe?g|webp)$/i;
const TEXT_KEYS = ["text", "prompt", "value", "string"];
const PARAM_TYPES = ["INT", "FLOAT", "BOOLEAN", "STRING", "COMBO"];
// Inputs worth editing in a workflow that does not promote any: sampling, size, strength and model choices.
const PARAM_KEYS = new Set([
    "seed", "noise_seed", "steps", "cfg", "guidance", "denoise", "sampler_name", "scheduler", "shift", "width", "height",
    "megapixels", "resolution", "aspect_ratio", "strength", "strength_model", "strength_clip", "lora_name", "ckpt_name",
    "unet_name", "clip_name", "vae_name", "text", "prompt", "negative_prompt",
]);
const MODEL_FILE = /\.(safetensors|sft|ckpt|gguf|pth?|bin)$/i;
// Preview nodes that show the input next to the result; they do not name an image's role.
const PREVIEWS = new Set(["ImageCompare", "PreviewImage"]);

/* Parses a registered workflow file, either format. */
function parseWorkflow(text) {
    let workflow;
    try {
        workflow = JSON.parse(text);
    } catch (err) {
        throw new Error(`Not a JSON file: ${err.message}`);
    }
    if (!isUiWorkflow(workflow)) checkApiWorkflow(workflow);
    return workflow;
}

function checkApiWorkflow(workflow) {
    const nodes = workflow && typeof workflow === "object" ? Object.values(workflow) : [];
    if (!nodes.length || !nodes.every((n) => typeof n?.class_type === "string" && n.inputs && typeof n.inputs === "object")) {
        throw new Error("Not a ComfyUI workflow. Save it from ComfyUI with Workflow > Save or Workflow > Export (API).");
    }
}

const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string";

function label(id, node) {
    return `${node._meta?.title ?? node.class_type} (#${id})`;
}

/* Ids of the nodes that feed the given input, walking upstream. Nodes that pass positive and negative through keep the two apart. */
function upstream(api, id, key, seen = new Set()) {
    const value = api[id]?.inputs[key];
    if (!isLink(value) || !api[value[0]]) return seen;
    const [origin, slot] = value;
    const mark = `${origin}:${slot}`;
    if (seen.has(mark)) return seen;
    seen.add(mark);
    seen.add(origin);
    const inputs = api[origin].inputs;
    const paired = "positive" in inputs && "negative" in inputs;
    for (const input of Object.keys(inputs)) {
        if (paired && ((slot === 0 && input === "negative") || (slot === 1 && input === "positive"))) continue;
        upstream(api, origin, input, seen);
    }
    return seen;
}

function textKey(node) {
    return TEXT_KEYS.find((key) => typeof node.inputs[key] === "string");
}

/* The name of the first input the image output of node `id` feeds, e.g. "image_1" for a "images.image_1" key. */
function consumerKey(api, id) {
    for (const node of Object.values(api)) {
        if (PREVIEWS.has(node.class_type)) continue;
        for (const [key, value] of Object.entries(node.inputs)) {
            if (isLink(value) && value[0] === id && value[1] === 0) return key.split(".").pop();
        }
    }
    return null;
}

/*
 * Roles of the Load Image nodes of a regular workflow: the label of the input each one feeds,
 * which template authors name image1, reference_image2 and so on. Returns { nodeId: role }.
 */
function imageRoles(ui) {
    const links = new Map((ui.links ?? []).map((l) => (Array.isArray(l) ? [l[0], { target_id: l[3], target_slot: l[4] }] : [l.id, l])));
    const nodes = new Map((ui.nodes ?? []).map((n) => [n.id, n]));
    const roles = {};
    for (const node of nodes.values()) {
        if (!/LoadImage/i.test(node.type)) continue;
        const targets = (node.outputs?.[0]?.links ?? []).map((id) => links.get(id)).filter((link) => link && nodes.has(link.target_id) && !PREVIEWS.has(nodes.get(link.target_id).type));
        const inputs = targets.map((link) => nodes.get(link.target_id).inputs?.[link.target_slot]).filter(Boolean);
        const input = inputs.find((i) => i.label) ?? inputs[0];
        if (input) roles[String(node.id)] = input.label ?? input.name;
    }
    return roles;
}

const byRole = (a, b) => a.role.localeCompare(b.role, undefined, { numeric: true }) || a.id.localeCompare(b.id, undefined, { numeric: true });

/*
 * Where the layers and the prompt go in an API workflow.
 * image: every Load Image node as a slot { id, key, label, role }, Photoshop Image nodes first,
 * then in role order; each slot gets its own layer (see resolveTargets).
 * prompt: { candidates: [{ id, key, label }], auto } where auto is the list used when the user
 * has not chosen: the Photoshop Prompt nodes when present, otherwise the text that feeds a
 * sampler's positive input. auto is null when there are several and the user has to choose.
 */
function findTargets(api, roles = {}) {
    const entries = Object.entries(api);
    const candidates = (test, key) => entries.filter(([, n]) => test(n)).map(([id, n]) => ({ id, key: key(n), label: label(id, n) }));
    const marked = (list, type) => list.filter((c) => api[c.id].class_type === type || /photoshop/i.test(api[c.id]._meta?.title ?? ""));

    // Load Image nodes nothing reads (a bypassed branch, say) get no slot.
    const images = candidates((n) => (n.class_type === IMAGE_NODE || /LoadImage/i.test(n.class_type)) && typeof n.inputs.image === "string", () => "image");
    for (const slot of images) slot.role = roles[slot.id] ?? consumerKey(api, slot.id) ?? "image";
    for (const slot of images.filter((s) => !consumerKey(api, s.id))) images.splice(images.indexOf(slot), 1);
    const markedImages = marked(images, IMAGE_NODE);
    const image = [...markedImages.sort(byRole), ...images.filter((c) => !markedImages.includes(c)).sort(byRole)];

    const texts = candidates((n) => textKey(n) && (n.class_type === PROMPT_NODE || /text|prompt|string/i.test(n.class_type)), textKey);
    const markedTexts = marked(texts, PROMPT_NODE);
    let auto = markedTexts;
    if (!auto.length) {
        const positive = new Set();
        for (const [id, node] of entries) {
            for (const key of ["positive", "conditioning"]) {
                if (key === "conditioning" && !/Guider/.test(node.class_type)) continue;
                upstream(api, id, key, positive);
            }
        }
        const fed = texts.filter((c) => positive.has(c.id));
        auto = fed.length <= 1 ? fed : null;
    }
    return { image, prompt: { candidates: texts, auto } };
}

/*
 * Applies the user's saved choice to findTargets(): choice.sources maps an image node id to
 * its source ("active", "selected:N", "canvas", "layer:<name>" or "keep"); the first slot
 * defaults to the selection or selected layer, further ones to the next selected layers.
 * choice.prompt is the prompt node id ("" = automatic).
 */
function resolveTargets(api, choice = {}, roles) {
    const found = findTargets(api, roles);
    const image = found.image.map((slot, i) => ({ ...slot, source: choice.sources?.[slot.id] ?? (i ? `selected:${i + 1}` : "active") }));
    const chosen = choice.prompt && found.prompt.candidates.find((c) => c.id === choice.prompt);
    let prompt;
    if (chosen) prompt = [chosen];
    else if (found.prompt.auto) prompt = found.prompt.auto;
    else throw new Error('This workflow has several nodes that could receive the prompt. Choose one under "Inputs" on the Workflows tab.');
    return { image, prompt, found };
}

/* The model files an API workflow loads, as one string to compare workflows by. */
function modelFiles(api) {
    const files = Object.values(api).flatMap((node) => Object.values(node.inputs).filter((v) => typeof v === "string" && MODEL_FILE.test(v)));
    return [...new Set(files)].sort().join("|");
}

/*
 * Models a regular workflow lists on its nodes (name, url, directory) that none of the
 * server's loader combos offer. Template authors fill these in; the panel shows them with
 * their download links before the run fails on them.
 */
function missingModels(ui, defs) {
    const missing = new Map();
    const graphs = [ui, ...(ui.definitions?.subgraphs ?? [])];
    for (const node of graphs.flatMap((g) => g.nodes ?? [])) {
        const def = defs[node.type];
        // Combos are saved either as a list of options or as ["COMBO", { options }].
        const options = Object.values({ ...def?.input?.required, ...def?.input?.optional }).flatMap(([type, opts]) => (Array.isArray(type) ? type : type === "COMBO" ? opts?.options ?? [] : []));
        for (const model of node.properties?.models ?? []) {
            const have = options.some((o) => o === model.name || o.replace(/\\/g, "/").endsWith(`/${model.name}`));
            if (!have && !missing.has(model.name)) missing.set(model.name, model);
        }
    }
    return [...missing.values()];
}

/* The widget spec of an input from a node definition: { type, options, min, max, step }, or null when it is not a plain widget. */
function inputSpec(def, key) {
    const spec = def?.input?.required?.[key] ?? def?.input?.optional?.[key];
    if (!spec) return null;
    const [socketType, opts = {}] = spec;
    const type = Array.isArray(socketType) ? "COMBO" : opts.widgetType ?? socketType;
    if (!PARAM_TYPES.includes(type) || opts.forceInput) return null;
    const out = { type };
    if (type === "COMBO") out.options = Array.isArray(socketType) ? socketType : opts.options ?? [];
    if (type === "STRING") out.multiline = !!opts.multiline;
    for (const k of ["min", "max", "step"]) if (typeof opts[k] === "number") out[k] = opts[k];
    return out;
}

/*
 * The settings of an API workflow the panel lets the user edit: the inputs the workflow author
 * exposed (promoted subgraph widgets and titled primitives, from convert.js) when there are
 * any, otherwise the usual sampling, size and model inputs; with `all`, every plain widget.
 * Inputs that take the layer or the prompt are left out. Each entry is
 * { id, key, label, group, type, options?, min?, max?, step?, value }.
 */
function workflowParams(api, defs, exposed = [], targets = { image: [], prompt: [] }, all = false) {
    const taken = new Set([...targets.image, ...targets.prompt].map((t) => `${t.id}/${t.key}`));
    const params = [];
    const add = ({ id, key, label: text, group }) => {
        const node = api[id];
        const value = node?.inputs[key];
        if (value === undefined || isLink(value) || taken.has(`${id}/${key}`)) return;
        const spec = inputSpec(defs[node.class_type], key);
        if (!spec) return;
        taken.add(`${id}/${key}`);
        params.push({ id, key, label: text, group, ...spec, value });
    };
    exposed.forEach(add);
    if (!params.length || all) {
        for (const [id, node] of Object.entries(api)) {
            for (const key of Object.keys(node.inputs)) {
                if (all || (PARAM_KEYS.has(key) && (!/^(width|height)$/.test(key) || /Latent|Size|Resolution/i.test(node.class_type)))) add({ id, key, label: key, group: label(id, node) });
            }
        }
    }
    return params;
}

/* Width and height with the shape of `size` and about `area` pixels, in multiples of 16. */
function fitSize(size, area) {
    const scale = Math.sqrt(area / (size.width * size.height));
    const snap = (v) => Math.max(16, Math.round((v * scale) / 16) * 16);
    return { width: snap(size.width), height: snap(size.height) };
}

/*
 * Returns a copy of `workflow` (API format) with the user's settings, the uploaded layers,
 * the panel prompt, the generation size and fresh seeds filled in. `targets` comes from
 * resolveTargets() with `image` set on the slots that were uploaded; `values` maps "id/key"
 * to a setting value; `size` is the shape of the area the result will cover, used when no
 * layer is sent.
 */
function prepareWorkflow(workflow, { prompt = "", targets, values = {}, size, randomizeSeed = false, random = Math.random }) {
    const prepared = JSON.parse(JSON.stringify(workflow));
    for (const [path, value] of Object.entries(values)) {
        const [id, key] = path.split("/");
        if (prepared[id] && key in prepared[id].inputs && !isLink(prepared[id].inputs[key])) prepared[id].inputs[key] = value;
    }
    for (const slot of targets.image) if (slot.image) prepared[slot.id].inputs[slot.key] = slot.image;
    if (prompt.trim()) for (const target of targets.prompt) prepared[target.id].inputs[target.key] = prompt;

    if (size) {
        const nodes = Object.values(prepared);
        const sizeNodes = nodes.filter((n) => n.class_type === SIZE_NODE);
        const latents = nodes.filter((n) => /^Empty.*Latent/.test(n.class_type));
        for (const node of sizeNodes.length ? sizeNodes : latents) {
            const { width, height } = node.inputs;
            if (typeof width === "number" && typeof height === "number") Object.assign(node.inputs, fitSize(size, width * height));
        }
    }

    if (randomizeSeed) {
        for (const node of Object.values(prepared)) {
            for (const key of ["seed", "noise_seed"]) {
                if (typeof node.inputs[key] === "number") node.inputs[key] = Math.floor(random() * 2 ** 48);
            }
        }
    }
    return prepared;
}

/* Images to place from a finished /history entry: Send to Photoshop outputs, else saved images, else previews. */
function resultImages(workflow, historyEntry) {
    const sent = [], saved = [], previews = [];
    for (const [nodeId, output] of Object.entries(historyEntry.outputs ?? {})) {
        for (const image of output.images ?? []) {
            if (!PLACEABLE.test(image.filename)) continue;
            if (workflow[nodeId]?.class_type === OUTPUT_NODE) sent.push(image);
            else if (image.type === "output") saved.push(image);
            else previews.push(image);
        }
    }
    return sent.length ? sent : saved.length ? saved : previews;
}

/* Error text for a failed or interrupted /history entry, null when it succeeded. */
function historyError(historyEntry) {
    const status = historyEntry.status ?? {};
    if (status.status_str !== "error") return null;
    for (const [type, data] of status.messages ?? []) {
        if (type === "execution_error") return `${data.node_type}: ${data.exception_message}`.trim();
        if (type === "execution_interrupted") return "Cancelled.";
    }
    return "The workflow failed.";
}

/* Message for a rejected POST /prompt (validation errors). */
function promptError(body) {
    if (typeof body === "string") return body;
    const lines = [body.error?.message ?? "ComfyUI rejected the workflow."];
    for (const node of Object.values(body.node_errors ?? {})) {
        for (const err of node.errors ?? []) lines.push(`${node.class_type}: ${err.message}${err.details ? ` (${err.details})` : ""}`);
    }
    return lines.join("\n");
}

module.exports = { parseWorkflow, checkApiWorkflow, imageRoles, findTargets, resolveTargets, modelFiles, missingModels, workflowParams, fitSize, prepareWorkflow, resultImages, historyError, promptError };
