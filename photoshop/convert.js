/*
 * Geekatplay Photoshop Bridge - regular workflow to API workflow conversion
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 *
 * Turns a workflow saved with Workflow > Save into the API format /prompt accepts,
 * following what the ComfyUI frontend does when it queues: widget values come from
 * widgets_values laid out like the frontend builds widgets, links are resolved
 * through reroutes, primitives, bypassed nodes and subgraphs, and muted nodes drop out.
 * `defs` maps node class names to their /object_info entries.
 */
const SUBGRAPH_INPUT = -10;
const MUTED = 2;
const BYPASSED = 4;

// Input types the frontend turns into widgets (ComfyWidgets plus core extension widgets).
const WIDGET_TYPES = new Set([
    "INT", "FLOAT", "BOOLEAN", "STRING", "COMBO", "MARKDOWN", "IMAGEUPLOAD", "COLOR", "IMAGECOMPARE",
    "BOUNDING_BOX", "CHART", "GALLERIA", "PAINTER", "COMPOSITOR", "TEXTAREA", "CURVE", "RANGE", "VIDEO_EDIT",
    "RESOLUTION_PREVIEW", "BOUNDING_BOXES", "COLORS", "COMFY_DYNAMICCOMBO_V3",
]);

// Core nodes whose frontend adds widgets that cannot be derived from their definition.
const UNCONVERTIBLE = new Set([
    "Load3D", "Load3DAdvanced", "Preview3DAdvanced", "Save3DAdvanced", "PreviewGaussianSplat", "PreviewPointCloud",
    "SaveGaussianSplat", "SavePointCloud", "WebcamCapture", "RecordAudio",
]);

class ConversionError extends Error {}

function isWidgetType(type) {
    return Array.isArray(type) || WIDGET_TYPES.has(type);
}

function validConnection(a, b) {
    if (a === "" || a === "*") a = 0;
    if (b === "" || b === "*") b = 0;
    if (!a || !b || a === b) return true;
    a = String(a).toLowerCase();
    b = String(b).toLowerCase();
    if (!a.includes(",") && !b.includes(",")) return a === b;
    return a.split(",").some((x) => b.split(",").some((y) => validConnection(x, y)));
}

/* Same as the frontend's processDynamicPrompt: strips comments and picks one option of each {a|b}. */
function processDynamicPrompt(text, random) {
    text = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    let i = 0;
    const escape = () => "\\" + text[i++];
    const choice = () => {
        const options = [];
        let current = "";
        let depth = 0;
        while (i < text.length) {
            const c = text[i++];
            if (c === "\\") {
                current += escape();
                continue;
            }
            if (c === "{") depth++;
            else if (c === "}") {
                if (!depth) break;
                depth--;
            } else if (c === "|" && !depth) {
                options.push(current);
                current = "";
                continue;
            }
            current += c;
        }
        options.push(current);
        return processDynamicPrompt(options[Math.floor(random() * options.length)], random);
    };
    let out = "";
    while (i < text.length) {
        const c = text[i++];
        out += c === "\\" ? escape() : c === "{" ? choice() : c;
    }
    return out.replace(/\\([{}|])/g, "$1");
}

/*
 * The node's widgets in frontend order. Entries with a widget are sent to the API; null
 * entries only take a widgets_values slot (control_after_generate, control_filter_list,
 * upload buttons). A dynamic combo is followed by the widgets of its selected option, so
 * the layout depends on the saved values: saved(name, index) returns one, or undefined.
 */
function widgetLayout(def, saved) {
    const layout = [];
    let upload = false;
    const walk = (inputs, order, prefix) => {
        for (const group of ["required", "optional"]) {
            const specs = inputs?.[group] ?? {};
            for (const key of order?.[group] ?? Object.keys(specs)) {
                const [socketType, opts = {}] = specs[key];
                const type = opts.widgetType ?? socketType;
                const name = prefix + key;
                if (opts.forceInput || !isWidgetType(type)) continue;
                if (type === "COMFY_DYNAMICCOMBO_V3") {
                    const keys = opts.options.map((o) => o.key);
                    layout.push({ name, type: "COMBO", opts: {}, options: keys });
                    const value = saved(name, layout.length - 1) ?? keys[0];
                    const chosen = opts.options.find((o) => o.key === value);
                    if (chosen) walk(chosen.inputs, null, `${name}.`);
                    continue;
                }
                if (type === "RESOLUTION_PREVIEW") {
                    layout.push(null);
                    continue;
                }
                const combo = Array.isArray(type) || type === "COMBO";
                layout.push({ name, type: combo ? "COMBO" : type, opts, options: Array.isArray(type) ? type : opts.options });
                if (opts.remote?.refresh_button) layout.push(null, null); // auto-refresh toggle, refresh button
                const control = type === "INT" ? opts.control_after_generate ?? ["seed", "noise_seed"].includes(name) : opts.control_after_generate;
                if (control) {
                    layout.push(null);
                    if (combo && !opts.multi_select) layout.push(null);
                }
                if (opts.component === "ImageCrop") layout.push(null, null, null, null); // x, y, width, height
                if (combo && (opts.image_upload || opts.animated_image_upload || opts.video_upload || opts.audio_upload)) upload = true;
            }
        }
    };
    walk(def.input, def.input_order, "");
    if (upload) layout.push(null); // the upload button comes after all other widgets
    return layout;
}

/* The frontend's migrateWidgetsValues: very old saves kept a widgets_values slot for forceInput inputs. */
function migrateValues(def, values) {
    const flags = [];
    for (const group of ["required", "optional"]) {
        const specs = def.input?.[group] ?? {};
        for (const key of def.input_order?.[group] ?? Object.keys(specs)) {
            const [type, opts = {}] = specs[key];
            if (!opts.forceInput && !isWidgetType(type)) continue;
            flags.push(!!opts.forceInput);
            if (opts.control_after_generate) flags.push(false);
        }
    }
    return flags.length === values.length && flags.some(Boolean) ? values.filter((_, i) => !flags[i]) : values;
}

function defaultValue(widget) {
    if (widget.opts.default !== undefined) return widget.opts.default;
    if (widget.type === "COMBO") return widget.options?.[0];
    return { INT: 0, FLOAT: 0, BOOLEAN: false, STRING: "" }[widget.type];
}

function apiValue(widget, value) {
    if (widget.type === "IMAGECOMPARE") return { __value__: ["", ""] }; // preview-only; the frontend always sends this
    if (widget.type === "CURVE" && value != null) return { __type__: "CURVE", __value__: value };
    return Array.isArray(value) ? { __value__: value } : value;
}

function flattenSubgraphs(list) {
    return list.flatMap((sub) => [sub, ...flattenSubgraphs(sub.definitions?.subgraphs ?? [])]);
}

/*
 * The frontend keeps node ids unique across the workflow: an inner node whose id is already
 * taken (by a root node or an earlier subgraph) gets the next free id after last_node_id.
 * Execution ids are built from these ids, so do the same.
 */
function renumberSubgraphNodes(ui, subgraphs) {
    const used = new Set(ui.nodes.map((n) => String(n.id)));
    let last = Number(ui.state?.lastNodeId ?? ui.last_node_id ?? 0);
    const remaps = new Map();
    for (const sub of subgraphs) {
        const remap = new Map();
        for (const node of sub.nodes ?? []) {
            const id = String(node.id);
            if (used.has(id)) {
                do last++; while (used.has(String(last)));
                remap.set(id, last);
                node.id = last;
                used.add(String(last));
            } else {
                used.add(id);
                if (Number.isInteger(Number(id))) last = Math.max(last, Number(id));
            }
        }
        if (!remap.size) continue;
        remaps.set(sub.id, remap);
        for (const link of sub.links ?? []) {
            link.origin_id = remap.get(String(link.origin_id)) ?? link.origin_id;
            link.target_id = remap.get(String(link.target_id)) ?? link.target_id;
        }
    }
    for (const node of [...ui.nodes, ...subgraphs.flatMap((s) => s.nodes ?? [])]) {
        const remap = remaps.get(node.type);
        const proxies = proxyWidgets(node);
        if (remap && proxies) node.properties.proxyWidgets = proxies.map(([id, ...rest]) => [String(remap.get(String(id)) ?? id), ...rest]);
    }
}

/* [[innerNodeId, widgetName], ...] of the inner widgets shown on a subgraph node, if saved that way. */
function proxyWidgets(node) {
    const proxies = node.properties?.proxyWidgets;
    return typeof proxies === "string" ? JSON.parse(proxies) : proxies;
}

class Converter {
    constructor(ui, defs, random) {
        this.defs = defs;
        this.random = random;
        ui = JSON.parse(JSON.stringify(ui));
        const subgraphs = flattenSubgraphs(ui.definitions?.subgraphs ?? []);
        renumberSubgraphNodes(ui, subgraphs);
        this.subgraphs = new Map(subgraphs.map((sub) => [sub.id, this.graph(sub)]));
        this.root = this.graph(ui);
        this.overrides = new Map(); // node -> { widgetName: value } set by PrimitiveNodes
        this.dtos = new Map();
        this.skipped = new Set();
    }

    graph(data) {
        const links = new Map();
        const linksByTarget = new Map(); // "node:slot" -> first link ending there
        for (const l of data.links ?? []) {
            const link = Array.isArray(l) ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] } : l;
            links.set(link.id, link);
            const target = `${link.target_id}:${link.target_slot}`;
            if (!linksByTarget.has(target)) linksByTarget.set(target, link);
        }
        return { data, links, linksByTarget, nodes: new Map((data.nodes ?? []).map((n) => [n.id, n])) };
    }

    /* The link into an input. Like the frontend on load, a reference to a link ending at another node is replaced by the link ending at this slot. */
    inputLink(dto, slot) {
        const id = dto.node.inputs?.[slot]?.link;
        const link = id == null ? undefined : dto.graph.links.get(id);
        if (link && String(link.target_id) === String(dto.node.id)) return link;
        return dto.graph.linksByTarget.get(`${dto.node.id}:${slot}`);
    }

    isSubgraph(node) {
        return this.subgraphs.has(node.type);
    }

    addNodes(graph, path, host) {
        for (const node of graph.nodes.values()) {
            const dto = { id: [...path, node.id].join(":"), node, graph, path, host };
            this.dtos.set(dto.id, dto);
            // Like the frontend, only root-level muted or bypassed subgraphs leave their nodes out.
            if (this.isSubgraph(node) && (path.length || (node.mode !== MUTED && node.mode !== BYPASSED))) {
                dto.subgraph = this.subgraphs.get(node.type);
                this.addNodes(dto.subgraph, [...path, node.id], dto);
            }
        }
    }

    applyPrimitives(graph) {
        for (const node of graph.nodes.values()) {
            if (node.type !== "PrimitiveNode") continue;
            for (const linkId of node.outputs?.[0]?.links ?? []) {
                const link = graph.links.get(linkId);
                const target = link && graph.nodes.get(link.target_id);
                const name = target?.inputs?.find((input) => input.link === linkId)?.widget?.name;
                if (!name) continue;
                if (!this.overrides.has(target)) this.overrides.set(target, {});
                this.overrides.get(target)[name] = node.widgets_values?.[0];
            }
        }
    }

    def(dto) {
        const def = this.defs[dto.node.type];
        if (!def) throw new ConversionError(`Node "${dto.node.title ?? dto.node.type}" (${dto.node.type}) is not installed on this ComfyUI server.`);
        return def;
    }

    /* [[widget, value], ...] for the widgets sent to the API, as the frontend holds them after loading. */
    widgetValues(node) {
        const def = this.defs[node.type];
        // widgets_values is positional; some custom node frontends save an object keyed by name.
        // (widgets_values_named is ignored like the frontend does by default; it can be stale.)
        const positional = Array.isArray(node.widgets_values) ? migrateValues(def, node.widgets_values) : null;
        const saved = (name, i) => (positional ? positional[i] : node.widgets_values?.[name]);
        const overrides = this.overrides.get(node) ?? {};
        return widgetLayout(def, saved).flatMap((widget, i) => {
            if (!widget) return [];
            let value = saved(widget.name, i);
            if (value === undefined) value = defaultValue(widget);
            if (widget.name in overrides) value = overrides[widget.name];
            if (value == null && widget.type === "COMBO") value = widget.options?.[0];
            return [[widget, value]];
        });
    }

    widgetInputs(dto) {
        this.def(dto);
        if (UNCONVERTIBLE.has(dto.node.type)) {
            throw new ConversionError(`${dto.node.type} cannot be read from a regular workflow file. Register a Workflow > Export (API) file instead.`);
        }
        const inputs = {};
        for (const [widget, value] of this.widgetValues(dto.node)) {
            inputs[widget.name] = widget.type === "STRING" && widget.opts.dynamicPrompts === true && typeof value === "string"
                ? processDynamicPrompt(value, this.random)
                : apiValue(widget, value);
        }
        const saved = dto.node.widgets_values;
        if (dto.node.type === "CustomCombo" && Array.isArray(saved)) {
            // The frontend adds the selected index and the user's options after the combo; the node reads them.
            inputs.index = saved[1];
            saved.slice(2).forEach((option, i) => (inputs[`option${i + 1}`] = option));
        }
        return inputs;
    }

    resolveInput(dto, slot, visited, type) {
        const key = `${dto.id}[I]${slot}`;
        if (visited.has(key)) throw new ConversionError(`Circular link at node ${dto.id}.`);
        visited.add(key);
        const input = dto.node.inputs?.[slot];
        const link = input && this.inputLink(dto, slot);
        if (!link) return undefined;

        if (dto.host && link.origin_id === SUBGRAPH_INPUT) {
            const host = dto.host;
            const subInput = host.subgraph.data.inputs?.[link.origin_slot];
            const hostSlot = host.node.inputs?.findIndex((i) => i.name === subInput?.name) ?? -1;
            if (hostSlot !== -1 && this.inputLink(host, hostSlot)) return this.resolveInput(host, hostSlot, visited);
            return this.promotedValue(host, link.origin_slot);
        }

        const origin = dto.graph.nodes.get(link.origin_id);
        if (!origin) return undefined;
        return this.resolveOutput(this.dtos.get([...dto.path, origin.id].join(":")), link.origin_slot, type ?? input.type, visited);
    }

    /* Value of a subgraph input that is shown as a widget on the subgraph node and not linked outside. */
    promotedValue(host, inputIndex) {
        const sub = host.subgraph;
        const proxies = proxyWidgets(host.node);
        if (proxies) {
            // The promoted widget is an inner widget fed by this input; its value is sent as is.
            for (const link of sub.links.values()) {
                if (link.origin_id !== SUBGRAPH_INPUT || link.origin_slot !== inputIndex) continue;
                const target = sub.nodes.get(link.target_id);
                const name = target?.inputs?.find((i) => i.link === link.id)?.widget?.name;
                if (!name || !this.defs[target.type] || !proxies.some(([id, widget]) => String(id) === String(target.id) && widget === name)) continue;
                const entry = this.widgetValues(target).find(([widget]) => widget.name === name);
                if (entry) return { widgetValue: entry[1] };
            }
            return undefined;
        }
        // Older saves keep promoted widget values on the subgraph node, one per widget-typed input.
        const values = host.node.widgets_values;
        if (!Array.isArray(values) || !values.length) return undefined;
        const promoted = sub.data.inputs.filter((i) => isWidgetType(i.type));
        const index = promoted.indexOf(sub.data.inputs[inputIndex]);
        return index === -1 || index >= values.length ? undefined : { widgetValue: values[index] };
    }

    resolveOutput(dto, slot, type, visited) {
        const key = `${dto.id}[O]${slot}`;
        if (visited.has(key)) throw new ConversionError(`Circular link at node ${dto.id}.`);
        visited.add(key);
        const { node } = dto;
        if (node.mode === MUTED) return undefined;
        if (node.mode === BYPASSED) {
            const index = this.bypassSlot(node, slot, type);
            return index === -1 ? undefined : this.resolveInput(dto, index, visited);
        }
        if (this.isSubgraph(node)) {
            const sub = dto.subgraph;
            const link = sub.links.get(sub.data.outputs?.[slot]?.linkIds?.[0]);
            if (!link) return undefined;
            const inner = this.dtos.get([...dto.path, node.id, link.origin_id].join(":"));
            if (!inner) throw new ConversionError(`Subgraph "${sub.data.name}" passes an input straight to an output, which ComfyUI cannot queue.`);
            return this.resolveOutput(inner, link.origin_slot, type, visited);
        }
        if (this.defs[node.type]) return { id: dto.id, slot };

        // Frontend-only nodes.
        if (node.type === "GetNode") {
            const name = node.widgets_values?.[0];
            const setter = [...dto.graph.nodes.values()].find((n) => n.type === "SetNode" && n.widgets_values?.[0] === name);
            if (!setter) throw new ConversionError(`Get node "${name}" has no matching Set node.`);
            return this.resolveInput(this.dtos.get([...dto.path, setter.id].join(":")), 0, visited, type);
        }
        if (node.type === "PrimitiveNode" || !node.inputs?.length) {
            if (node.type !== "PrimitiveNode") this.def(dto); // not a reroute-like node: report it as missing
            return undefined;
        }
        if (node.inputs.length === 1) return this.resolveInput(dto, 0, visited, type); // Reroute and reroute-like nodes
        this.def(dto);
    }

    /* The frontend's ExecutableNodeDTO._getBypassSlotIndex. */
    bypassSlot(node, slot, type) {
        const inputs = node.inputs ?? [];
        const outputType = node.outputs?.[slot]?.type;
        if (type === "*" || type === "") return inputs.length > slot ? slot : 0;
        const same = inputs[slot];
        if (same && validConnection(same.type, outputType) && validConnection(same.type, type)) return slot;
        const exact = inputs.findIndex((i) => i.type === type);
        return exact !== -1 ? exact : inputs.findIndex((i) => validConnection(i.type, outputType) && validConnection(i.type, type));
    }

    convert() {
        for (const graph of [this.root, ...this.subgraphs.values()]) this.applyPrimitives(graph);
        this.addNodes(this.root, [], null);

        const output = {};
        for (const dto of this.dtos.values()) {
            const { node } = dto;
            if (node.mode === MUTED || node.mode === BYPASSED || this.isSubgraph(node)) continue;
            if (!this.defs[node.type]) {
                // Notes, reroutes, primitives and other frontend-only or missing nodes are not
                // part of the prompt; a missing node that something depends on fails in resolveOutput.
                if (!["Note", "MarkdownNote", "Reroute", "PrimitiveNode", "SetNode", "GetNode"].includes(node.type)) this.skipped.add(node.type);
                continue;
            }
            const inputs = this.widgetInputs(dto);
            (node.inputs ?? []).forEach((input, slot) => {
                const resolved = this.resolveInput(dto, slot, new Set());
                if (!resolved) return;
                inputs[input.name] = "widgetValue" in resolved
                    ? (Array.isArray(resolved.widgetValue) ? { __value__: resolved.widgetValue } : resolved.widgetValue)
                    : [String(resolved.id), resolved.slot];
            });
            output[dto.id] = { inputs, class_type: node.type, _meta: { title: node.title ?? this.defs[node.type].display_name ?? node.type } };
        }
        for (const { inputs } of Object.values(output)) {
            for (const [name, value] of Object.entries(inputs)) {
                if (Array.isArray(value) && value.length === 2 && !output[value[0]]) delete inputs[name];
            }
        }
        return output;
    }

    /*
     * The inputs the workflow author put forward, in their order: widgets promoted onto
     * subgraph nodes (proxyWidgets) and titled primitive nodes at the root. Each entry is
     * { id, key, label, group } in terms of the converted prompt.
     */
    exposed() {
        const list = [];
        for (const dto of this.dtos.values()) {
            const { node } = dto;
            if (!dto.path.length && PRIMITIVES.has(node.type) && node.title && node.outputs?.[0]?.links?.length) {
                list.push({ id: dto.id, key: "value", label: node.title, group: "" });
            }
            const proxies = dto.subgraph && proxyWidgets(node);
            for (const [innerId, key] of proxies ?? []) {
                const inner = this.dtos.get([dto.id, ...String(innerId).split(":")].join(":"));
                if (inner) list.push({ id: inner.id, key, label: this.proxyLabel(inner, key), group: node.title ?? dto.subgraph.data.name });
            }
        }
        return list;
    }

    /* A promoted widget is named after the subgraph input that feeds it, else after its node. */
    proxyLabel(inner, key) {
        const slot = inner.node.inputs?.findIndex((i) => i.widget?.name === key || i.name === key) ?? -1;
        const link = slot === -1 ? null : this.inputLink(inner, slot);
        const input = link?.origin_id === SUBGRAPH_INPUT ? inner.host.subgraph.data.inputs?.[link.origin_slot] : null;
        if (input) return input.label ?? input.name;
        const title = inner.node.title ?? this.defs[inner.node.type]?.display_name ?? inner.node.type;
        return `${title}: ${key}`;
    }
}

const PRIMITIVES = new Set(["PrimitiveInt", "PrimitiveFloat", "PrimitiveBoolean", "PrimitiveString", "PrimitiveStringMultiline"]);

function isUiWorkflow(data) {
    return Array.isArray(data?.nodes);
}

/* Node class names the conversion needs definitions for. */
function uiNodeTypes(ui) {
    const subgraphIds = new Set((ui.definitions?.subgraphs ?? []).map((s) => s.id));
    const types = new Set();
    for (const graph of [ui, ...(ui.definitions?.subgraphs ?? [])]) {
        for (const node of graph.nodes ?? []) if (!subgraphIds.has(node.type)) types.add(node.type);
    }
    return [...types];
}

/*
 * Returns { prompt, skipped, exposed }: the API workflow, the types of nodes that were left
 * out because the server does not know them and nothing depends on them, and the inputs the
 * author exposed (see Converter.exposed).
 */
function convertUiWorkflow(ui, defs, random = Math.random) {
    if (ui.extra?.groupNodes && Object.keys(ui.extra.groupNodes).length) {
        throw new ConversionError("This workflow uses legacy group nodes. Convert them to subgraphs in ComfyUI, or register a Workflow > Export (API) file.");
    }
    const converter = new Converter(ui, defs, random);
    const prompt = converter.convert();
    return { prompt, skipped: [...converter.skipped], exposed: converter.exposed() };
}

module.exports = { isUiWorkflow, uiNodeTypes, convertUiWorkflow, widgetLayout, processDynamicPrompt, ConversionError };
