/*
 * Geekatplay Photoshop Bridge - ComfyUI frontend extension
 * by Geekatplay Studio - Vladimir Chopine
 * https://www.geekatplay.com
 *
 * When the Photoshop panel sends a layer to the active workflow, switch every
 * Photoshop Image node in the open workflow to the new image and, when a prompt
 * came with it, every Photoshop Prompt node to that prompt.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function setWidget(comfyClass, name, value) {
    const graphs = [app.graph, ...(app.graph.subgraphs?.values() ?? [])];
    for (const node of graphs.flatMap((graph) => graph.nodes.filter((n) => n.comfyClass === comfyClass))) {
        const widget = node.widgets.find((w) => w.name === name);
        if (widget.type === "combo" && !widget.options.values.includes(value)) widget.options.values.unshift(value);
        widget.value = value;
        widget.callback?.(value, app.canvas, node);
    }
}

app.registerExtension({
    name: "Geekatplay.PhotoshopBridge",
    setup() {
        api.addEventListener("geekatplay.photoshop.send", ({ detail }) => {
            setWidget("GeekatplayPhotoshopImage", "image", detail.image);
            if (detail.prompt) setWidget("GeekatplayPhotoshopPrompt", "text", detail.prompt);
            app.graph.setDirtyCanvas(true, true);
        });
    },
});
