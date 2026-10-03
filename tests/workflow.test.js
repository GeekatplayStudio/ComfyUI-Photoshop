/*
 * Geekatplay Photoshop Bridge - tests for photoshop/workflow.js
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 *
 *     node --test "tests/*.test.js"
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseWorkflow, imageRoles, findTargets, resolveTargets, modelFiles, missingModels, workflowParams, fitSize, prepareWorkflow, resultImages, historyError, promptError } = require("../photoshop/workflow.js");

const API = {
    "1": { class_type: "GeekatplayPhotoshopImage", inputs: { image: "photoshop/old.png" } },
    "2": { class_type: "GeekatplayPhotoshopPrompt", inputs: { text: "default prompt" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: ["2", 0], clip: ["9", 1] } },
    "4": { class_type: "KSampler", inputs: { seed: 5, steps: 20, model: ["9", 0], positive: ["3", 0], latent_image: ["5", 0] } },
    "5": { class_type: "VAEEncode", inputs: { pixels: ["1", 0], vae: ["9", 2] } },
    "6": { class_type: "RandomNoise", inputs: { noise_seed: ["7", 0] } },
    "8": { class_type: "GeekatplaySendToPhotoshop", inputs: { images: ["4", 0], filename_prefix: "Photoshop/result" } },
};

// A plain workflow with no Photoshop nodes: checkpoint, two encoders, ControlNet passing both through.
const PLAIN = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
    "2": { class_type: "CLIPTextEncode", _meta: { title: "Positive" }, inputs: { text: "a fox", clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", _meta: { title: "Negative" }, inputs: { text: "blurry", clip: ["1", 1] } },
    "4": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "5": { class_type: "ControlNetApplyAdvanced", inputs: { positive: ["2", 0], negative: ["3", 0], image: ["4", 0] } },
    "6": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "7": { class_type: "KSampler", inputs: { seed: 1, model: ["1", 0], positive: ["5", 0], negative: ["5", 1], latent_image: ["6", 0] } },
};

const ids = (list) => list.map((t) => t.id);

test("parseWorkflow accepts API and regular workflows and explains junk", () => {
    assert.deepEqual(parseWorkflow(JSON.stringify(API)), API);
    const ui = { nodes: [{ id: 1, type: "KSampler", mode: 0 }], links: [] };
    assert.deepEqual(parseWorkflow(JSON.stringify(ui)), ui);
    assert.throws(() => parseWorkflow("{not json"), /Not a JSON file/);
    assert.throws(() => parseWorkflow("{}"), /Not a ComfyUI workflow/);
    assert.throws(() => parseWorkflow("[1, 2]"), /Not a ComfyUI workflow/);
});

test("Photoshop nodes are the automatic targets", () => {
    const targets = resolveTargets(API);
    assert.deepEqual(targets.image, [{ id: "1", key: "image", label: "GeekatplayPhotoshopImage (#1)", role: "pixels", source: "active" }]);
    assert.deepEqual(targets.prompt, [{ id: "2", key: "text", label: "GeekatplayPhotoshopPrompt (#2)" }]);
});

test("without Photoshop nodes: the only Load Image and the text feeding the sampler's positive input", () => {
    const targets = resolveTargets(PLAIN);
    assert.deepEqual(ids(targets.image), ["4"]);
    assert.deepEqual(ids(targets.prompt), ["2"], "the negative encoder behind the ControlNet is not picked");
    assert.deepEqual(ids(targets.found.prompt.candidates), ["2", "3"]);
});

test("a prompt primitive feeding the encoder, guiders and titles are understood", () => {
    const primitive = {
        "1": { class_type: "PrimitiveStringMultiline", inputs: { value: "a fox" } },
        "2": { class_type: "CLIPTextEncode", inputs: { text: ["1", 0] } },
        "3": { class_type: "FluxGuidance", inputs: { conditioning: ["2", 0], guidance: 3.5 } },
        "4": { class_type: "BasicGuider", inputs: { conditioning: ["3", 0] } },
    };
    assert.deepEqual(resolveTargets(primitive).prompt, [{ id: "1", key: "value", label: "PrimitiveStringMultiline (#1)" }]);

    const titled = JSON.parse(JSON.stringify(PLAIN));
    titled["8"] = { class_type: "LoadImage", _meta: { title: "Photoshop layer" }, inputs: { image: "b.png" } };
    titled["11"] = { class_type: "VAEEncode", inputs: { pixels: ["8", 0] } };
    assert.deepEqual(ids(resolveTargets(titled).image), ["8", "4"], "the Photoshop-titled node comes first");
});

test("every Load Image something reads is a slot with its own source, in role order", () => {
    const two = JSON.parse(JSON.stringify(PLAIN));
    two["8"] = { class_type: "LoadImage", inputs: { image: "b.png" } };
    two["9"] = { class_type: "TextEncodeQwenImageEditPlus", inputs: { "images.image_2": ["8", 0], "images.image_1": ["4", 0], prompt: "x" } };
    two["10"] = { class_type: "LoadImage", inputs: { image: "unused.png" } };
    const slots = resolveTargets(two).image;
    assert.deepEqual(slots.map((s) => [s.id, s.role, s.source]), [["4", "image", "active"], ["8", "image_2", "selected:2"]]);
    const chosen = resolveTargets(two, { sources: { "8": "layer:Reference" } }).image;
    assert.deepEqual(chosen.map((s) => s.source), ["active", "layer:Reference"]);

    const roles = imageRoles({
        nodes: [
            { id: 4, type: "LoadImage", outputs: [{ links: [1, 2] }] },
            { id: 8, type: "LoadImage", outputs: [{ links: [3] }] },
            { id: 20, type: "sub", inputs: [{ name: "image" }, { name: "image_1", label: "reference_image2" }] },
            { id: 21, type: "sub", inputs: [{ name: "image", label: "reference_image1" }] },
        ],
        links: [[1, 4, 0, 20, 0, "IMAGE"], [2, 4, 0, 21, 0, "IMAGE"], [3, 8, 0, 20, 1, "IMAGE"]],
    });
    assert.deepEqual(roles, { "4": "reference_image1", "8": "reference_image2" }, "a labelled input names the role");
    assert.deepEqual(resolveTargets(two, {}, roles).image.map((s) => s.role), ["reference_image1", "reference_image2"]);
});

test("a workflow with several prompt nodes asks the user, and the saved choice is used", () => {
    const two = JSON.parse(JSON.stringify(PLAIN));
    two["9"] = { class_type: "CLIPTextEncode", inputs: { text: "second" } };
    two["7"].inputs.positive = ["10", 0];
    two["10"] = { class_type: "ConditioningCombine", inputs: { conditioning_1: ["5", 0], conditioning_2: ["9", 0] } };
    assert.equal(findTargets(two).prompt.auto, null);
    assert.throws(() => resolveTargets(two), /several nodes.*prompt/);
    assert.deepEqual(ids(resolveTargets(two, { prompt: "9" }).prompt), ["9"]);
});

test("a workflow without an image input generates from the prompt", () => {
    const generate = JSON.parse(JSON.stringify(PLAIN));
    delete generate["4"];
    delete generate["5"].inputs.image;
    assert.deepEqual(resolveTargets(generate).image, []);
});

test("prepareWorkflow fills settings, images, prompt and seeds without touching the original", () => {
    const targets = resolveTargets(API);
    targets.image[0].image = "photoshop/new.png";
    const values = { "4/steps": 30, "4/model": "ignored: links stay", "99/x": 1 };
    const prepared = prepareWorkflow(API, { prompt: "a fennec girl", targets, values, randomizeSeed: true, random: () => 0.5 });
    assert.equal(prepared["1"].inputs.image, "photoshop/new.png");
    assert.equal(prepared["2"].inputs.text, "a fennec girl");
    assert.equal(prepared["4"].inputs.steps, 30);
    assert.deepEqual(prepared["4"].inputs.model, ["9", 0]);
    assert.equal(prepared["4"].inputs.seed, 2 ** 47);
    assert.deepEqual(prepared["6"].inputs.noise_seed, ["7", 0], "linked seeds stay linked");
    assert.equal(API["1"].inputs.image, "photoshop/old.png");
    assert.equal(API["4"].inputs.seed, 5);

    const kept = prepareWorkflow(API, { prompt: "  ", targets: resolveTargets(API) });
    assert.equal(kept["1"].inputs.image, "photoshop/old.png", "a slot without an upload keeps the workflow's file");
    assert.equal(kept["2"].inputs.text, "default prompt");
    assert.equal(kept["4"].inputs.seed, 5);
});

test("generation size follows the target shape and keeps the workflow's pixel count", () => {
    assert.deepEqual(fitSize({ width: 3000, height: 2000 }, 1024 * 1024), { width: 1248, height: 832 });
    assert.deepEqual(fitSize({ width: 100, height: 100 }, 1024 * 1024), { width: 1024, height: 1024 });

    const sized = { ...PLAIN, "8": { class_type: "GeekatplayPhotoshopSize", inputs: { width: 1024, height: 1024 } } };
    const withNode = prepareWorkflow(sized, { targets: resolveTargets(sized), size: { width: 1000, height: 2000 } });
    assert.deepEqual([withNode["8"].inputs.width, withNode["8"].inputs.height], [720, 1456]);
    assert.equal(withNode["6"].inputs.width, 1024, "empty latents are left alone when a Photoshop Size node exists");

    const plain = prepareWorkflow(PLAIN, { targets: resolveTargets(PLAIN), size: { width: 1000, height: 2000 } });
    assert.deepEqual([plain["6"].inputs.width, plain["6"].inputs.height], [720, 1456]);
});

test("modelFiles tells workflows with different models apart", () => {
    const a = { "1": { class_type: "UNETLoader", inputs: { unet_name: "z.safetensors", weight_dtype: "default" } }, "2": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } } };
    const sameModels = { "9": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } }, "3": { class_type: "UNETLoader", inputs: { unet_name: "z.safetensors" } }, "4": { class_type: "CLIPTextEncode", inputs: { text: "other prompt" } } };
    assert.equal(modelFiles(a), "ae.safetensors|z.safetensors");
    assert.equal(modelFiles(sameModels), modelFiles(a));
    assert.notEqual(modelFiles(PLAIN), modelFiles(a));
});

test("workflowParams lists the exposed inputs, else the usual sampling and model inputs", () => {
    const defs = {
        KSampler: { input: { required: { model: ["MODEL"], seed: ["INT", { default: 0, min: 0 }], steps: ["INT", { min: 1, max: 100 }], sampler_name: [["euler", "dpmpp_2m"]] } } },
        CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }] } } },
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors"]] } } },
        EmptyLatentImage: { input: { required: { width: ["INT", {}], height: ["INT", {}], batch_size: ["INT", {}] } } },
    };
    const targets = resolveTargets(PLAIN);
    const usual = workflowParams(PLAIN, defs, [], targets);
    assert.deepEqual(usual.map((p) => `${p.id}/${p.key}`), ["1/ckpt_name", "3/text", "6/width", "6/height", "7/seed"], "the prompt, links and inputs without a definition are left out");
    assert.deepEqual(usual[4], { id: "7", key: "seed", label: "seed", group: "KSampler (#7)", type: "INT", min: 0, value: 1 });
    assert.deepEqual(usual[0].options, ["a.safetensors"]);
    assert.equal(usual[1].multiline, true);

    const exposed = [{ id: "7", key: "seed", label: "Seed", group: "Main" }, { id: "7", key: "model", label: "linked", group: "Main" }, { id: "2", key: "text", label: "the prompt", group: "Main" }];
    assert.deepEqual(workflowParams(PLAIN, defs, exposed, targets).map((p) => p.label), ["Seed"]);
    assert.deepEqual(workflowParams(PLAIN, defs, exposed, targets, true).map((p) => p.label), ["Seed", "ckpt_name", "text", "width", "height", "batch_size"], "'all' adds every plain widget after the exposed ones");
});

test("missingModels compares the models a workflow lists with the server's loader options", () => {
    const defs = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl/sd_xl_base_1.0.safetensors"]] } } } };
    const ui = {
        nodes: [{ id: 1, type: "CheckpointLoaderSimple", properties: { models: [{ name: "sd_xl_base_1.0.safetensors", url: "https://x/a", directory: "checkpoints" }] } }],
        definitions: { subgraphs: [{ id: "s", nodes: [{ id: 2, type: "UNETLoader", properties: { models: [{ name: "flux.safetensors", url: "https://x/b", directory: "diffusion_models" }, { name: "flux.safetensors", url: "https://x/b" }] } }] }] },
    };
    assert.deepEqual(missingModels(ui, defs).map((m) => m.name), ["flux.safetensors"], "a model in a subfolder counts; subgraph nodes are checked; duplicates listed once");
});

test("resultImages prefers Send to Photoshop, then saved images, then previews", () => {
    const img = (filename, type) => ({ filename, subfolder: "", type });
    const outputs = {
        "8": { images: [img("sent_00001_.png", "output")] },
        "10": { images: [img("saved_00001_.png", "output")] },
        "11": { images: [img("preview_00001_.png", "temp")] },
    };
    const wf = { ...API, "10": { class_type: "SaveImage", inputs: {} }, "11": { class_type: "PreviewImage", inputs: {} } };
    assert.deepEqual(resultImages(wf, { outputs }).map((i) => i.filename), ["sent_00001_.png"]);
    delete outputs["8"];
    assert.deepEqual(resultImages(wf, { outputs }).map((i) => i.filename), ["saved_00001_.png"]);
    delete outputs["10"];
    assert.deepEqual(resultImages(wf, { outputs }).map((i) => i.filename), ["preview_00001_.png"]);
    assert.deepEqual(resultImages(wf, { outputs: { "12": { images: [img("clip.mp4", "output")] } } }), []);
});

test("historyError and promptError read ComfyUI's error shapes", () => {
    assert.equal(historyError({ status: { status_str: "success", messages: [] } }), null);
    const failed = { status: { status_str: "error", messages: [["execution_start", {}], ["execution_error", { node_type: "KSampler", exception_message: "CUDA out of memory" }]] } };
    assert.equal(historyError(failed), "KSampler: CUDA out of memory");
    assert.equal(historyError({ status: { status_str: "error", messages: [["execution_interrupted", {}]] } }), "Cancelled.");

    const rejected = {
        error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" },
        node_errors: { "4": { class_type: "CheckpointLoaderSimple", errors: [{ message: "Value not in list", details: "ckpt_name: 'x.safetensors' not in []" }] } },
    };
    assert.equal(promptError(rejected), "Prompt outputs failed validation\nCheckpointLoaderSimple: Value not in list (ckpt_name: 'x.safetensors' not in [])");
});
