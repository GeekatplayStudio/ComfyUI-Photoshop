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

/*
 * Where the layer and the prompt can go in an API workflow.
 * Returns { image, prompt }, each { candidates: [{ id, key, label }], auto } where auto is
 * the list used when the user has not chosen: the Photoshop nodes when present, otherwise
 * the only Load Image node, and the text that feeds a sampler's positive input. auto is
 * null when there are several possibilities and the user has to choose.
 */
function findTargets(api) {
    const entries = Object.entries(api);
    const candidates = (test, key) => entries.filter(([, n]) => test(n)).map(([id, n]) => ({ id, key: key(n), label: label(id, n) }));
    const marked = (list, type) => list.filter((c) => api[c.id].class_type === type || /photoshop/i.test(api[c.id]._meta?.title ?? ""));

    const images = candidates((n) => (n.class_type === IMAGE_NODE || /LoadImage/i.test(n.class_type)) && typeof n.inputs.image === "string", () => "image");
    const markedImages = marked(images, IMAGE_NODE);
    const image = { candidates: images, auto: markedImages.length ? markedImages : images.length <= 1 ? images : null };

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

/* Applies the user's saved choice ({ image, prompt } node ids, "" = automatic) to findTargets(). */
function resolveTargets(api, choice = {}) {
    const found = findTargets(api);
    const pick = (kind, what) => {
        const chosen = choice[kind] && found[kind].candidates.find((c) => c.id === choice[kind]);
        if (chosen) return [chosen];
        if (found[kind].auto) return found[kind].auto;
        throw new Error(`This workflow has several nodes that could receive the ${what}. Choose one under "Inputs" on the Workflows tab.`);
    };
    return { image: pick("image", "layer"), prompt: pick("prompt", "prompt"), found };
}

/* Width and height with the shape of `size` and about `area` pixels, in multiples of 16. */
function fitSize(size, area) {
    const scale = Math.sqrt(area / (size.width * size.height));
    const snap = (v) => Math.max(16, Math.round((v * scale) / 16) * 16);
    return { width: snap(size.width), height: snap(size.height) };
}

/*
 * Returns a copy of `workflow` (API format) with the uploaded layer, the panel prompt, the
 * generation size and fresh seeds filled in. `targets` comes from resolveTargets(); `size`
 * is the shape of the area the result will cover, used when no layer is sent.
 */
function prepareWorkflow(workflow, { image, prompt = "", targets, size, randomizeSeed = false, random = Math.random }) {
    const prepared = JSON.parse(JSON.stringify(workflow));
    if (image) for (const target of targets.image) prepared[target.id].inputs[target.key] = image;
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

module.exports = { parseWorkflow, checkApiWorkflow, findTargets, resolveTargets, fitSize, prepareWorkflow, resultImages, historyError, promptError };
