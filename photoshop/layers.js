/*
 * Geekatplay Photoshop Bridge - reading layers and placing results
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 */
const { app, core, action, imaging, constants } = require("photoshop");
const { storage } = require("uxp");

const fs = storage.localFileSystem;
const SRGB = "sRGB IEC61966-2.1";

function findLayer(layers, id) {
    for (const layer of layers) {
        if (layer.id === id) return layer;
        const inGroup = layer.layers && findLayer(layer.layers, id);
        if (inGroup) return inGroup;
    }
    return null;
}

function openDocument() {
    if (!app.documents.length) throw new Error("Open a document in Photoshop first.");
    return app.activeDocument;
}

/* Bounds of the selection in document pixels, clipped to the canvas; null without a selection. */
async function selectionBounds(doc) {
    const [info] = await action.batchPlay([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }] }], {});
    const s = info?.selection;
    if (!s?.right) return null;
    const bounds = {
        left: Math.max(0, Math.floor(s.left._value)),
        top: Math.max(0, Math.floor(s.top._value)),
        right: Math.min(doc.width, Math.ceil(s.right._value)),
        bottom: Math.min(doc.height, Math.ceil(s.bottom._value)),
    };
    return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null;
}

/*
 * Where a generated image goes when no pixels are sent: the selection, or the whole canvas.
 * Returns { target, width, height }.
 */
async function canvasTarget() {
    const doc = openDocument();
    const bounds = (await selectionBounds(doc)) ?? { left: 0, top: 0, right: doc.width, bottom: doc.height };
    return { target: { docId: doc.id, layerId: doc.activeLayers[0]?.id, bounds }, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
}

/*
 * Reads the pixels to send as 8-bit sRGB, scaled down so the long edge is at most `maxEdge`
 * (0 keeps full size): with a selection, what is visible inside its bounds; otherwise the
 * selected layer. `target` remembers where the result should go.
 */
async function readSource(maxEdge) {
    const doc = openDocument();
    if (doc.bitsPerChannel === constants.BitsPerChannelType.THIRTYTWO) {
        throw new Error("32-bit documents are not supported. Convert to 16 or 8 Bits/Channel (Image > Mode).");
    }
    const selection = await selectionBounds(doc);
    const layer = doc.activeLayers[0];
    if (!selection && !layer) throw new Error("Select a layer or make a selection to send.");
    // Document pixels. getPixels reports its sourceBounds in the coordinates of the pyramid
    // level it read, which is not the document when targetSize scales the pixels down.
    const b = selection ?? layer.boundsNoEffects;
    const bounds = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (width <= 0 || height <= 0) throw new Error(`Layer "${layer.name}" is empty.`);

    const options = { documentID: doc.id, colorSpace: "RGB", colorProfile: SRGB };
    if (selection) options.sourceBounds = bounds;
    else options.layerID = layer.id;
    if (maxEdge > 0 && Math.max(width, height) > maxEdge) options.targetSize = width >= height ? { width: maxEdge } : { height: maxEdge };

    return core.executeAsModal(async () => {
        const { imageData } = await imaging.getPixels(options);
        let pixels = await imageData.getData({ chunky: true, fullRange: true });
        if (imageData.componentSize === 16) {
            const bytes = new Uint8Array(pixels.length);
            for (let i = 0; i < pixels.length; i++) bytes[i] = pixels[i] >>> 8;
            pixels = bytes;
        }
        const read = {
            pixels,
            width: imageData.width,
            height: imageData.height,
            components: imageData.components,
            name: `${doc.title.replace(/\.[^.]+$/, "")} - ${selection ? "selection" : layer.name}`,
            target: { docId: doc.id, layerId: layer?.id, bounds },
        };
        imageData.dispose();
        return read;
    }, { commandName: "Read Pixels for ComfyUI" });
}

/*
 * Places an image file as a smart object layer. With a `target` from readSource the
 * layer goes above the source layer and is fitted to its bounds; otherwise it lands in the
 * active document where Photoshop places it.
 */
async function placeImage(bytes, filename, target, layerName) {
    const file = await (await fs.getTemporaryFolder()).createFile(filename, { overwrite: true });
    await file.write(bytes, { format: storage.formats.binary });
    try {
        await core.executeAsModal(async (context) => {
            if (!app.documents.length) throw new Error("Open a document to receive the ComfyUI result.");
            let doc = target && Array.from(app.documents).find((d) => d.id === target.docId);
            if (doc) {
                if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
            } else {
                doc = app.activeDocument;
                target = null;
            }

            const suspension = await context.hostControl.suspendHistory({ documentID: doc.id, name: "Place ComfyUI Result" });
            try {
                const source = target && findLayer(doc.layers, target.layerId);
                if (source) await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: source.id }], makeVisible: false }], {});

                await action.batchPlay([{
                    _obj: "placeEvent",
                    null: { _path: fs.createSessionToken(file), _kind: "local" },
                    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
                    offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
                    _options: { dialogOptions: "dontDisplay" },
                }], {});
                const layer = doc.activeLayers[0];
                layer.name = layerName;

                if (target) {
                    // Photoshop scales placed files by resolution and canvas size; fit the
                    // result to the source layer bounds, centered. A result whose aspect is only
                    // off by rounding or a multiple-of-8 crop is stretched to cover the source.
                    const box = target.bounds;
                    const boxW = box.right - box.left;
                    const boxH = box.bottom - box.top;
                    let b = layer.boundsNoEffects;
                    const sx = boxW / (b.right - b.left);
                    const sy = boxH / (b.bottom - b.top);
                    const fill = Math.abs(sx / sy - 1) < 0.03;
                    await layer.scale((fill ? sx : Math.min(sx, sy)) * 100, (fill ? sy : Math.min(sx, sy)) * 100, constants.AnchorPosition.TOPLEFT);
                    b = layer.boundsNoEffects;
                    await layer.translate(box.left + (boxW - (b.right - b.left)) / 2 - b.left, box.top + (boxH - (b.bottom - b.top)) / 2 - b.top);
                }
            } finally {
                await context.hostControl.resumeHistory(suspension);
            }
        }, { commandName: "Place ComfyUI Result" });
    } finally {
        await file.delete();
    }
}

module.exports = { readSource, canvasTarget, placeImage };
