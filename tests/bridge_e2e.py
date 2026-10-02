"""
Geekatplay Photoshop Bridge - end-to-end check against a running ComfyUI
by Geekatplay Studio - Vladimir Chopine
https://www.geekatplay.com

Does what the Photoshop panel does over HTTP: upload layer pixels, run a workflow
headless, follow the panel state route and download the result.

    python tests/bridge_e2e.py --base http://127.0.0.1:8188
"""
import argparse
import asyncio
import io
import json
import time
import uuid

import aiohttp
import numpy as np
from PIL import Image


def layer_pixels(width, height):
    y, x = np.mgrid[0:height, 0:width]
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[..., 0] = x * 255 // (width - 1)
    rgba[..., 1] = y * 255 // (height - 1)
    rgba[..., 2] = 40
    rgba[..., 3] = np.where(x < width // 2, 255, 64)
    return rgba


async def upload(session, base, rgba):
    h, w, c = rgba.shape
    params = {"width": w, "height": h, "components": c, "name": "Test doc - Layer 1"}
    async with session.post(f"{base}/geekatplay/photoshop/upload", params=params, data=rgba.tobytes()) as res:
        assert res.status == 200, await res.text()
        return (await res.json())["image"]


async def view(session, base, image):
    async with session.get(f"{base}/view", params=image) as res:
        assert res.status == 200, await res.text()
        return np.array(Image.open(io.BytesIO(await res.read())))


async def run(session, base, prompt):
    prompt_id = str(uuid.uuid4())
    async with session.post(f"{base}/prompt", json={"prompt": prompt, "prompt_id": prompt_id, "client_id": "bridge-e2e"}) as res:
        assert res.status == 200, await res.text()
    for _ in range(600):
        async with session.get(f"{base}/history/{prompt_id}") as res:
            entry = (await res.json()).get(prompt_id)
        if entry:
            assert entry["status"]["status_str"] == "success", json.dumps(entry["status"])
            return prompt_id, entry
        await asyncio.sleep(0.1)
    raise TimeoutError(prompt_id)


async def state(session, base, after=None):
    params = {} if after is None else {"after": after}
    async with session.get(f"{base}/geekatplay/photoshop/state", params=params) as res:
        assert res.status == 200, await res.text()
        return await res.json()


async def main(base):
    rgba = layer_pixels(64, 48)
    async with aiohttp.ClientSession() as session:
        # Upload -> PNG in input/photoshop with the alpha channel intact.
        name = await upload(session, base, rgba)
        assert name.startswith("photoshop/") and name.endswith(".png"), name
        stored = await view(session, base, {"filename": name.split("/", 1)[1], "subfolder": "photoshop", "type": "input"})
        assert np.array_equal(stored, rgba)
        print("upload ok:", name)

        # Truncated upload is rejected.
        async with session.post(f"{base}/geekatplay/photoshop/upload", params={"width": 64, "height": 48, "components": 4}, data=b"\0" * 10) as res:
            assert res.status == 400, res.status
        print("short upload rejected ok")

        # The browser gets an event for "send to active workflow" uploads.
        async with session.ws_connect(f"{base}/ws?clientId=bridge-e2e-ws") as ws:
            notified = await upload(session, base, rgba)
            sent = {"image": notified, "prompt": "a cute fennec girl"}
            async with session.post(f"{base}/geekatplay/photoshop/send", json=sent) as res:
                assert res.status == 200, await res.text()
            deadline = time.time() + 5
            while time.time() < deadline:
                msg = await ws.receive(timeout=5)
                if msg.type == aiohttp.WSMsgType.TEXT and json.loads(msg.data)["type"] == "geekatplay.photoshop.send":
                    assert json.loads(msg.data)["data"] == sent
                    break
            else:
                raise AssertionError("no geekatplay.photoshop.send event")
        print("send event ok")

        before = (await state(session, base))["seq"]

        # Headless run: Photoshop Image -> invert -> Send to Photoshop, and the mask path.
        prompt = {
            "1": {"class_type": "GeekatplayPhotoshopImage", "inputs": {"image": name}},
            "2": {"class_type": "ImageInvert", "inputs": {"image": ["1", 0]}},
            "3": {"class_type": "GeekatplaySendToPhotoshop", "inputs": {"images": ["2", 0], "filename_prefix": "Photoshop/e2e"}},
            "4": {"class_type": "MaskToImage", "inputs": {"mask": ["1", 1]}},
            "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": "Photoshop/e2e_mask"}},
            "6": {"class_type": "GeekatplayPhotoshopPrompt", "inputs": {"text": "a fennec girl with a fluffy tail"}},
        }
        prompt_id, entry = await run(session, base, prompt)
        sent = entry["outputs"]["3"]["images"]
        assert len(sent) == 1 and sent[0]["type"] == "output", sent
        result = await view(session, base, sent[0])
        assert np.abs(result[..., :3].astype(int) - (255 - rgba[..., :3].astype(int))).max() <= 1
        mask = await view(session, base, entry["outputs"]["5"]["images"][0])
        expected_mask = 255 - rgba[..., 3].astype(int)
        assert np.abs(mask[..., 0].astype(int) - expected_mask).max() <= 1
        print("headless run ok:", prompt_id)

        # The panel's state route reports the result with its prompt id and source image.
        st = await state(session, base, before)
        assert st["seq"] == before + 1, st
        r = st["results"][0]
        assert r["prompt_id"] == prompt_id and r["sources"] == [name] and r["images"] == sent, r
        assert (await state(session, base, st["seq"]))["results"] == []
        assert (await state(session, base))["results"] == []
        print("state route ok")

        # The Photoshop Image node lists uploads newest first.
        async with session.get(f"{base}/object_info/GeekatplayPhotoshopImage") as res:
            listed = (await res.json())["GeekatplayPhotoshopImage"]["input"]["required"]["image"][0]
        assert listed[0] == notified and name in listed, listed
        print("node file list ok")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8188")
    asyncio.run(main(parser.parse_args().base.rstrip("/")))
    print("all checks passed")
