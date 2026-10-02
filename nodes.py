"""
Geekatplay Photoshop Bridge - nodes
by Geekatplay Studio - Vladimir Chopine
https://www.geekatplay.com
"""
import collections
import itertools
import os

import folder_paths
import nodes
from comfy_execution.utils import get_executing_context

CATEGORY = "Geekatplay Studio/Photoshop"
SUBFOLDER = "photoshop"

# Recent Send to Photoshop results, read by the Photoshop panel through /geekatplay/photoshop/state.
RESULTS = collections.deque(maxlen=50)
_result_seq = itertools.count(1)


def photoshop_images():
    folder = os.path.join(folder_paths.get_input_directory(), SUBFOLDER)
    if not os.path.isdir(folder):
        return []
    files = folder_paths.filter_files_content_types(os.listdir(folder), ["image"])
    files.sort(key=lambda f: os.path.getmtime(os.path.join(folder, f)), reverse=True)
    return [f"{SUBFOLDER}/{f}" for f in files]


class PhotoshopImage(nodes.LoadImage):
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"image": (photoshop_images(), {"image_upload": True, "tooltip": "The layer sent from the Photoshop panel. Every send switches this node to the new layer."})}}

    CATEGORY = CATEGORY
    ESSENTIALS_CATEGORY = None
    SEARCH_ALIASES = ["photoshop", "photoshop layer", "photoshop image"]
    DESCRIPTION = "Loads the layer sent from Photoshop. The mask output comes from the layer transparency."


class PhotoshopPrompt:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"text": ("STRING", {"multiline": True, "tooltip": "Replaced by the prompt typed in the Photoshop panel when this workflow runs from Photoshop. Used as is when the panel prompt is empty."})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "prompt"
    CATEGORY = CATEGORY
    SEARCH_ALIASES = ["photoshop prompt"]
    DESCRIPTION = "Receives the prompt typed in the Photoshop panel. Connect it to the text input of your prompt encoder."

    def prompt(self, text):
        return (text,)


class PhotoshopSize:
    @classmethod
    def INPUT_TYPES(s):
        size = {"default": 1024, "min": 16, "max": 16384, "step": 16, "tooltip": "When this workflow runs from Photoshop, width and height are replaced to match the shape of the selection or canvas, keeping about this many pixels in total."}
        return {"required": {"width": ("INT", size), "height": ("INT", size)}}

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "size"
    CATEGORY = CATEGORY
    SEARCH_ALIASES = ["photoshop size", "photoshop canvas"]
    DESCRIPTION = "Size for images generated from a prompt. Connect it to the width and height of your empty latent."

    def size(self, width, height):
        return (width, height)


class SendToPhotoshop(nodes.SaveImage):
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "Each image is placed in Photoshop as a new layer."}),
                "filename_prefix": ("STRING", {"default": "Photoshop/result", "tooltip": "Prefix of the files saved to the output folder."}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "send"
    CATEGORY = CATEGORY
    ESSENTIALS_CATEGORY = None
    SEARCH_ALIASES = ["photoshop", "send to photoshop", "photoshop layer"]
    DESCRIPTION = "Saves the images to the output folder and sends them to the Photoshop panel, which places them as new layers."

    def send(self, images, filename_prefix="Photoshop/result", prompt=None, extra_pnginfo=None):
        ui = self.save_images(images, filename_prefix, prompt, extra_pnginfo)["ui"]
        # The panel uses the source image names to place the result back over the layer it came from.
        sources = [n["inputs"]["image"] for n in (prompt or {}).values()
                   if n.get("class_type") == "GeekatplayPhotoshopImage" and isinstance(n["inputs"].get("image"), str)]
        RESULTS.append({
            "seq": next(_result_seq),
            "prompt_id": get_executing_context().prompt_id,
            "sources": sources,
            "images": ui["images"],
        })
        return {"ui": ui}


NODE_CLASS_MAPPINGS = {
    "GeekatplayPhotoshopImage": PhotoshopImage,
    "GeekatplayPhotoshopPrompt": PhotoshopPrompt,
    "GeekatplayPhotoshopSize": PhotoshopSize,
    "GeekatplaySendToPhotoshop": SendToPhotoshop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GeekatplayPhotoshopImage": "Photoshop Image",
    "GeekatplayPhotoshopPrompt": "Photoshop Prompt",
    "GeekatplayPhotoshopSize": "Photoshop Size",
    "GeekatplaySendToPhotoshop": "Send to Photoshop",
}
