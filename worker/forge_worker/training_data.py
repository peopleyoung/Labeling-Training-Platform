import json
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import torch
from PIL import Image, ImageDraw
from torch.utils.data import Dataset


def load_manifest(path: str, expected_task: str) -> Dict[str, Any]:
    manifest_path = Path(path)
    if not manifest_path.is_file():
        raise RuntimeError(f"Training dataset manifest does not exist: {path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or manifest.get("task") != expected_task:
        raise RuntimeError(f"Training dataset manifest is not valid for {expected_task}")
    if not manifest.get("images"):
        raise RuntimeError("Training dataset manifest contains no usable images")
    return manifest


def split_images(manifest: Dict[str, Any], split: str) -> List[Dict[str, Any]]:
    images = [item for item in manifest["images"] if item.get("split") == split]
    if split == "validation" and not images:
        images = [item for item in manifest["images"] if item.get("split") == "train"]
    return images


def _normalized_image(path: str, image_size: int, normalization: str = "imagenet") -> torch.Tensor:
    image = Image.open(path).convert("RGB").resize((image_size, image_size), Image.Resampling.BILINEAR)
    pixels = np.asarray(image, dtype=np.float32)
    tensor = torch.from_numpy(pixels).permute(2, 0, 1)
    if normalization == "rknn":
        return (tensor - 127.5) / 127.5
    if normalization != "imagenet":
        raise RuntimeError(f"Unsupported image normalization: {normalization}")
    tensor = tensor / 255.0
    mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
    return (tensor - mean) / std


class SegmentationDataset(Dataset):
    def __init__(self, items: List[Dict[str, Any]], classes: List[str], image_size: int, normalization: str = "imagenet"):
        self.items = items
        self.classes = classes
        self.image_size = image_size
        self.normalization = normalization

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int):
        item = self.items[index]
        if item.get("maskPath"):
            mask = Image.open(item["maskPath"]).convert("L").resize((self.image_size, self.image_size), Image.Resampling.NEAREST)
            values = np.asarray(mask, dtype=np.int64).copy()
            if values.size and int(values.max()) > len(self.classes):
                raise RuntimeError("PNG mask contains a class id outside classes.json")
            return _normalized_image(item["path"], self.image_size, self.normalization), torch.from_numpy(values)
        mask = Image.new("L", (self.image_size, self.image_size), 0)
        draw = ImageDraw.Draw(mask)
        for annotation in item.get("annotations", []):
            if annotation.get("label") not in self.classes:
                continue
            class_id = self.classes.index(annotation["label"]) + 1
            geometry = annotation.get("geometry", {})
            if geometry.get("type") == "rectangle":
                left = round(float(geometry["x"]) * self.image_size / 100)
                top = round(float(geometry["y"]) * self.image_size / 100)
                right = round(float(geometry["x"] + geometry["width"]) * self.image_size / 100)
                bottom = round(float(geometry["y"] + geometry["height"]) * self.image_size / 100)
                draw.rectangle((left, top, right, bottom), fill=class_id)
            elif geometry.get("type") == "polygon":
                points = [(round(float(point["x"]) * self.image_size / 100), round(float(point["y"]) * self.image_size / 100)) for point in geometry.get("points", [])]
                if len(points) >= 3:
                    draw.polygon(points, fill=class_id)
        return _normalized_image(item["path"], self.image_size, self.normalization), torch.from_numpy(np.asarray(mask, dtype=np.int64).copy())


class KeypointDataset(Dataset):
    def __init__(self, items: List[Dict[str, Any]], keypoint_count: int, image_size: int):
        self.items = items
        self.keypoint_count = keypoint_count
        self.image_size = image_size
        coordinates = torch.arange(image_size, dtype=torch.float32)
        self.grid_y, self.grid_x = torch.meshgrid(coordinates, coordinates, indexing="ij")

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int):
        item = self.items[index]
        heatmaps = torch.zeros(self.keypoint_count, self.image_size, self.image_size)
        visible = torch.zeros(self.keypoint_count, dtype=torch.bool)
        sigma = max(1.5, self.image_size / 64)
        for annotation in item.get("annotations", []):
            geometry = annotation.get("geometry", {})
            if geometry.get("type") != "keypoint":
                continue
            channel = int(geometry["index"]) - 1
            if channel < 0 or channel >= self.keypoint_count:
                continue
            center_x = float(geometry["x"]) * self.image_size / 100
            center_y = float(geometry["y"]) * self.image_size / 100
            gaussian = torch.exp(-((self.grid_x - center_x) ** 2 + (self.grid_y - center_y) ** 2) / (2 * sigma * sigma))
            heatmaps[channel] = torch.maximum(heatmaps[channel], gaussian)
            visible[channel] = True
        return _normalized_image(item["path"], self.image_size), heatmaps, visible


class SdxlImageDataset(Dataset):
    def __init__(self, items: List[Dict[str, Any]], resolution: int):
        self.items = items
        self.resolution = resolution

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int):
        item = self.items[index]
        image = Image.open(item["path"]).convert("RGB")
        crop = item.get("crop")
        if crop:
            width, height = image.size
            left = round(float(crop["x"]) * width / 100)
            top = round(float(crop["y"]) * height / 100)
            right = round(float(crop["x"] + crop["width"]) * width / 100)
            bottom = round(float(crop["y"] + crop["height"]) * height / 100)
            image = image.crop((left, top, right, bottom))
        image = image.resize((self.resolution, self.resolution), Image.Resampling.BILINEAR)
        pixels = torch.from_numpy(np.asarray(image, dtype=np.float32).copy()).permute(2, 0, 1) / 127.5 - 1.0
        prompt = str(item.get("prompt") or "").strip()
        if not prompt:
            raise RuntimeError("SDXL training image is missing its reviewed caption")
        return pixels, prompt
