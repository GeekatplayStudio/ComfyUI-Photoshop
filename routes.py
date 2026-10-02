"""
Geekatplay Photoshop Bridge - HTTP routes used by the Photoshop panel
by Geekatplay Studio - Vladimir Chopine
https://www.geekatplay.com
"""
import asyncio
import json
import os
import re
import time

from aiohttp import web
from PIL import Image

import folder_paths
from comfy_execution.progress import NodeState, get_progress_state
from server import PromptServer

from .nodes import RESULTS, SUBFOLDER

routes = PromptServer.instance.routes
WORKFLOWS = os.path.join(os.path.dirname(__file__), "example_workflows")


def _unique_png(folder, stem):
    stem = re.sub(r"[^\w\- ]+", "_", stem).strip(" _")[:60] or "layer"
    stem = f"{stem}_{time.strftime('%Y%m%d-%H%M%S')}"
    name, n = f"{stem}.png", 1
    while os.path.exists(os.path.join(folder, name)):
        n += 1
        name = f"{stem}_{n}.png"
    return name


@routes.post("/geekatplay/photoshop/upload")
async def upload_layer(request):
    """Raw 8-bit chunky RGB/RGBA pixels from the panel -> PNG in input/photoshop."""
    q = request.rel_url.query
    width, height, components = int(q["width"]), int(q["height"]), int(q["components"])
    data = await request.read()
    if components not in (3, 4) or len(data) != width * height * components:
        return web.json_response({"error": f"Expected {width}x{height}x{components} bytes of pixel data, got {len(data)}."}, status=400)

    mode = "RGBA" if components == 4 else "RGB"
    image = Image.frombuffer(mode, (width, height), data, "raw", mode, 0, 1)
    folder = os.path.join(folder_paths.get_input_directory(), SUBFOLDER)
    os.makedirs(folder, exist_ok=True)
    filename = _unique_png(folder, q.get("name", "layer"))
    await asyncio.to_thread(image.save, os.path.join(folder, filename), compress_level=1)

    return web.json_response({"image": f"{SUBFOLDER}/{filename}"})


@routes.post("/geekatplay/photoshop/send")
async def send_to_open_workflow(request):
    """Tells the open ComfyUI pages to switch their Photoshop nodes to this layer and prompt."""
    data = await request.json()
    PromptServer.instance.send_sync("geekatplay.photoshop.send", {"image": data["image"], "prompt": data.get("prompt", "")})
    return web.json_response({})


@routes.get("/geekatplay/photoshop/workflows")
async def builtin_workflows(request):
    """The workflows shipped in example_workflows, by name; the panel lists them without registration."""
    workflows = {}
    for name in sorted(os.listdir(WORKFLOWS)):
        if name.endswith(".json"):
            with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as f:
                workflows[name[:-5]] = json.load(f)
    return web.json_response(workflows)


@routes.get("/geekatplay/photoshop/state")
async def panel_state(request):
    """New Send to Photoshop results after `after`, queue and step progress for the panel's status line, and whether a /free request is still waiting to be applied."""
    after = request.rel_url.query.get("after")
    results = [r for r in RESULTS if r["seq"] > int(after)] if after is not None else []
    running, queued = PromptServer.instance.prompt_queue.get_current_queue_volatile()

    registry = get_progress_state()
    progress = None
    for entry in list(registry.nodes.values()):  # the prompt worker thread adds entries while we read
        if entry["state"] == NodeState.Running:
            progress = {"prompt_id": registry.prompt_id, "value": entry["value"], "max": entry["max"]}

    return web.json_response({
        "seq": RESULTS[-1]["seq"] if RESULTS else 0,
        "results": results,
        "running": [item[1] for item in running],
        "pending": [item[1] for item in sorted(queued, key=lambda item: item[0])],
        "progress": progress,
        "freeing": bool(PromptServer.instance.prompt_queue.get_flags(reset=False)),
    })
