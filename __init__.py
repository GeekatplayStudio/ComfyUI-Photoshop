"""
Geekatplay Photoshop Bridge
by Geekatplay Studio - Vladimir Chopine
https://www.geekatplay.com

Send Photoshop layers to ComfyUI and bring the results back as new layers.
The Photoshop panel (UXP plugin) lives in the `photoshop` folder.
"""
from . import routes  # noqa: F401  registers the panel's HTTP routes
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
