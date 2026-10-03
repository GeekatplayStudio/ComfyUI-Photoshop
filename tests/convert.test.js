/*
 * Geekatplay Photoshop Bridge - tests for photoshop/convert.js
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 *
 *     node --test "tests/*.test.js"
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { convertUiWorkflow, uiNodeTypes, widgetLayout, processDynamicPrompt, ConversionError } = require("../photoshop/convert.js");

const FIXTURES = path.join(__dirname, "fixtures", "convert");
const DEFS = JSON.parse(fs.readFileSync(path.join(FIXTURES, "object_info.json"), "utf8"));

for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".api.json"))) {
    const name = file.slice(0, -".api.json".length);
    test(`converts ${name} like the ComfyUI frontend`, () => {
        const ui = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
        const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
        assert.deepEqual(convertUiWorkflow(ui, DEFS).prompt, expected);
    });
}

test("exposed inputs: promoted subgraph widgets, nested ones and titled primitives", () => {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
    const depth = convertUiWorkflow(read("flux_depth_lora_example"), DEFS).exposed;
    const keys = depth.map((e) => `${e.id}/${e.key}`);
    assert.ok(keys.includes("150:3/seed") && keys.includes("150:41:101/sigma"), keys.join(" "));
    assert.deepEqual(depth.find((e) => e.key === "seed"), { id: "150:3", key: "seed", label: "seed", group: "Depth to Image(Flux.1 Dev)" });
    assert.equal(depth.find((e) => e.key === "sigma").group, "Lotus Depth(Subgraph)");

    const relight = convertUiWorkflow(read("templates-product_scene_relight"), DEFS).exposed;
    assert.deepEqual(relight.map((e) => e.label), ["Describe the Product", "Prompt Template"]);
});

const defs = {
    GeekatplayPhotoshopImage: { input: { required: { image: [["a.png"], { image_upload: true }] } }, input_order: { required: ["image"] }, display_name: "Photoshop Image" },
    GeekatplayPhotoshopPrompt: { input: { required: { text: ["STRING", { multiline: true }] } }, input_order: { required: ["text"] }, display_name: "Photoshop Prompt" },
    CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true, dynamicPrompts: true }], clip: ["CLIP"] } }, input_order: { required: ["text", "clip"] }, display_name: "CLIP Text Encode (Prompt)" },
    KSampler: {
        input: { required: { model: ["MODEL"], seed: ["INT", { default: 0 }], steps: ["INT", { default: 20 }], sampler_name: [["euler", "dpmpp_2m"]] } },
        input_order: { required: ["model", "seed", "steps", "sampler_name"] },
        display_name: "KSampler",
    },
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors"]] } }, input_order: { required: ["ckpt_name"] }, display_name: "Load Checkpoint" },
    GeekatplaySendToPhotoshop: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "Photoshop/result" }] } }, input_order: { required: ["images", "filename_prefix"] }, display_name: "Send to Photoshop" },
    Load3D: { input: { required: { width: ["INT", {}] } }, input_order: { required: ["width"] }, display_name: "Load 3D" },
};

const node = (id, type, extra = {}) => ({ id, type, mode: 0, inputs: [], outputs: [], ...extra });

test("widget layout follows the frontend: seed control slot, upload button last", () => {
    assert.deepEqual(widgetLayout(defs.KSampler, () => undefined).map((w) => w?.name ?? null), ["seed", null, "steps", "sampler_name"]);
    assert.deepEqual(widgetLayout(defs.GeekatplayPhotoshopImage, () => undefined).map((w) => w?.name ?? null), ["image", null]);
});

test("converts a Photoshop workflow with widget values and links", () => {
    const ui = {
        last_node_id: 3,
        nodes: [
            node(1, "CheckpointLoaderSimple", { outputs: [{ type: "MODEL", links: [1] }], widgets_values: ["a.safetensors"] }),
            node(2, "KSampler", { inputs: [{ name: "model", type: "MODEL", link: 1 }], widgets_values: [42, "randomize", 30, "dpmpp_2m"] }),
            node(3, "GeekatplayPhotoshopImage", { widgets_values: ["photoshop/layer.png", "image"] }),
            node(4, "Note", { widgets_values: ["just a note"] }),
        ],
        links: [[1, 1, 0, 2, 0, "MODEL"]],
    };
    assert.deepEqual(convertUiWorkflow(ui, defs).prompt, {
        1: { inputs: { ckpt_name: "a.safetensors" }, class_type: "CheckpointLoaderSimple", _meta: { title: "Load Checkpoint" } },
        2: { inputs: { seed: 42, steps: 30, sampler_name: "dpmpp_2m", model: ["1", 0] }, class_type: "KSampler", _meta: { title: "KSampler" } },
        3: { inputs: { image: "photoshop/layer.png" }, class_type: "GeekatplayPhotoshopImage", _meta: { title: "Photoshop Image" } },
    });
});

test("a stale link reference falls back to the link that ends at the input", () => {
    const ui = {
        nodes: [
            node(1, "CheckpointLoaderSimple", { outputs: [{ type: "MODEL", links: [7] }], widgets_values: ["a.safetensors"] }),
            node(2, "KSampler", { inputs: [{ name: "model", type: "MODEL", link: 99 }], widgets_values: [1, "fixed", 20, "euler"] }),
            node(3, "KSampler", { widgets_values: [1, "fixed", 20, "euler"] }),
        ],
        links: [[99, 1, 0, 3, 0, "MODEL"], [7, 1, 0, 2, 0, "MODEL"]],
    };
    assert.deepEqual(convertUiWorkflow(ui, defs).prompt[2].inputs.model, ["1", 0]);
});

test("Set/Get nodes, reroutes and primitives resolve to real nodes and values", () => {
    const ui = {
        nodes: [
            node(1, "CheckpointLoaderSimple", { outputs: [{ type: "MODEL", links: [1] }], widgets_values: ["a.safetensors"] }),
            node(2, "SetNode", { inputs: [{ name: "MODEL", type: "MODEL", link: 1 }], widgets_values: ["model"] }),
            node(3, "GetNode", { outputs: [{ type: "MODEL", links: [2] }], widgets_values: ["model"] }),
            node(4, "Reroute", { inputs: [{ name: "", type: "*", link: 2 }], outputs: [{ type: "MODEL", links: [3] }] }),
            node(5, "PrimitiveNode", { outputs: [{ type: "INT", links: [4], widget: { name: "steps" } }], widgets_values: [12, "fixed"] }),
            node(6, "KSampler", {
                inputs: [{ name: "model", type: "MODEL", link: 3 }, { name: "steps", type: "INT", widget: { name: "steps" }, link: 4 }],
                widgets_values: [5, "fixed", 20, "euler"],
            }),
        ],
        links: [[1, 1, 0, 2, 0, "MODEL"], [2, 3, 0, 4, 0, "MODEL"], [3, 4, 0, 6, 0, "MODEL"], [4, 5, 0, 6, 1, "INT"]],
    };
    const prompt = convertUiWorkflow(ui, defs).prompt;
    assert.deepEqual(Object.keys(prompt).sort(), ["1", "6"]);
    assert.deepEqual(prompt[6].inputs, { seed: 5, steps: 12, sampler_name: "euler", model: ["1", 0] });
});

test("muted nodes drop out and bypassed nodes pass their input through", () => {
    const ui = {
        nodes: [
            node(1, "CheckpointLoaderSimple", { outputs: [{ type: "MODEL", links: [1] }], widgets_values: ["a.safetensors"] }),
            node(2, "KSampler", { mode: 4, inputs: [{ name: "model", type: "MODEL", link: 1 }], outputs: [{ type: "MODEL", links: [2] }], widgets_values: [1, "fixed", 1, "euler"] }),
            node(3, "KSampler", { inputs: [{ name: "model", type: "MODEL", link: 2 }], widgets_values: [1, "fixed", 1, "euler"] }),
            node(4, "KSampler", { mode: 2, outputs: [{ type: "MODEL", links: [3] }], widgets_values: [1, "fixed", 1, "euler"] }),
            node(5, "KSampler", { inputs: [{ name: "model", type: "MODEL", link: 3 }], widgets_values: [1, "fixed", 1, "euler"] }),
        ],
        links: [[1, 1, 0, 2, 0, "MODEL"], [2, 2, 0, 3, 0, "MODEL"], [3, 4, 0, 5, 0, "MODEL"]],
    };
    const prompt = convertUiWorkflow(ui, defs).prompt;
    assert.deepEqual(Object.keys(prompt).sort(), ["1", "3", "5"]);
    assert.deepEqual(prompt[3].inputs.model, ["1", 0]);
    assert.equal(prompt[5].inputs.model, undefined);
});

test("dynamic prompts are processed like the frontend", () => {
    assert.equal(processDynamicPrompt("a {red|blue} fox // comment", () => 0.9), "a blue fox ");
    const ui = { nodes: [node(1, "CLIPTextEncode", { widgets_values: ["a {cute|fluffy} fennec girl"] })], links: [] };
    assert.equal(convertUiWorkflow(ui, defs, () => 0).prompt[1].inputs.text, "a cute fennec girl");
});

test("missing nodes: leaf nodes are skipped and reported, needed ones fail clearly", () => {
    const leaf = { nodes: [node(1, "GeekatplayPhotoshopImage", { widgets_values: ["x.png"] }), node(2, "Fast Groups Bypasser (rgthree)")], links: [] };
    assert.deepEqual(convertUiWorkflow(leaf, defs).skipped, ["Fast Groups Bypasser (rgthree)"]);
    const needed = {
        nodes: [node(1, "MissingLoader", { outputs: [{ type: "MODEL", links: [1] }] }), node(2, "KSampler", { inputs: [{ name: "model", type: "MODEL", link: 1 }] })],
        links: [[1, 1, 0, 2, 0, "MODEL"]],
    };
    assert.throws(() => convertUiWorkflow(needed, defs), (err) => err instanceof ConversionError && /MissingLoader.*not installed/.test(err.message));
});

test("nodes the converter cannot read and legacy group nodes are refused", () => {
    assert.throws(() => convertUiWorkflow({ nodes: [node(1, "Load3D", { widgets_values: [512] })], links: [] }, defs), /Export \(API\)/);
    assert.throws(() => convertUiWorkflow({ nodes: [], links: [], extra: { groupNodes: { g: {} } } }, defs), /group nodes/);
});

test("uiNodeTypes lists the classes inside subgraphs, not the subgraph ids", () => {
    const ui = {
        nodes: [node(1, "sub-1"), node(2, "KSampler")],
        links: [],
        definitions: { subgraphs: [{ id: "sub-1", nodes: [node(3, "CLIPTextEncode")], links: [] }] },
    };
    assert.deepEqual(uiNodeTypes(ui).sort(), ["CLIPTextEncode", "KSampler"]);
});
