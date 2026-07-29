import os
import re
from pathlib import Path
from typing import List

import torch
from torch import nn
from torch.nn import functional as F

from .pretrained import configure_model_cache, explain_pretrained_failure, local_hrnet_checkpoint, segformer_source, timm_hrnet_source


def load_local_segformer_backbone(model: nn.Module, checkpoint_path: Path) -> int:
    raw_state = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if not isinstance(raw_state, dict):
        raise RuntimeError(f"Invalid SegFormer checkpoint: {checkpoint_path}")
    target_state = model.state_dict()
    converted = {}
    for source_key, value in raw_state.items():
        target_key = None
        patch = re.fullmatch(r"backbone\.patch_embed([1-4])\.(proj|norm)\.(.+)", source_key)
        block = re.fullmatch(r"backbone\.block([1-4])\.(\d+)\.(.+)", source_key)
        final_norm = re.fullmatch(r"backbone\.norm([1-4])\.(.+)", source_key)
        if patch:
            stage, component, suffix = int(patch.group(1)) - 1, patch.group(2), patch.group(3)
            component = "layer_norm" if component == "norm" else component
            target_key = f"segformer.encoder.patch_embeddings.{stage}.{component}.{suffix}"
        elif final_norm:
            stage, suffix = int(final_norm.group(1)) - 1, final_norm.group(2)
            target_key = f"segformer.encoder.layer_norm.{stage}.{suffix}"
        elif block:
            stage, index, suffix = int(block.group(1)) - 1, block.group(2), block.group(3)
            prefix = f"segformer.encoder.block.{stage}.{index}"
            replacements = {
                "norm1.": "layer_norm_1.",
                "attn.q.": "attention.self.query.",
                "attn.sr.": "attention.self.sr.",
                "attn.norm.": "attention.self.layer_norm.",
                "attn.proj.": "attention.output.dense.",
                "norm2.": "layer_norm_2.",
                "mlp.fc1.": "mlp.dense1.",
                "mlp.dwconv.": "mlp.dwconv.",
                "mlp.fc2.": "mlp.dense2.",
            }
            if suffix.startswith("attn.kv."):
                parameter = suffix.removeprefix("attn.kv.")
                key = f"{prefix}.attention.self.key.{parameter}"
                value_key, value_value = f"{prefix}.attention.self.value.{parameter}", value.chunk(2, dim=0)[1]
                key_value = value.chunk(2, dim=0)[0]
                if key in target_state and target_state[key].shape == key_value.shape:
                    converted[key] = key_value
                if value_key in target_state and target_state[value_key].shape == value_value.shape:
                    converted[value_key] = value_value
                continue
            for old, new in replacements.items():
                if suffix.startswith(old):
                    target_key = f"{prefix}.{new}{suffix.removeprefix(old)}"
                    break
        if target_key in target_state and target_state[target_key].shape == value.shape:
            converted[target_key] = value
    if len(converted) < 100:
        raise RuntimeError(f"SegFormer checkpoint mapped only {len(converted)} tensors; refusing partial pretrained load")
    model.load_state_dict(converted, strict=False)
    return len(converted)


class SegmentationOutput(nn.Module):
    def __init__(self, model: nn.Module, kind: str):
        super().__init__()
        self.model = model
        self.kind = kind

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        if self.kind == "segformer":
            logits = self.model(pixel_values=inputs).logits
        else:
            logits = self.model(inputs)
        return F.interpolate(logits, size=inputs.shape[-2:], mode="bilinear", align_corners=False)


class DoubleConv(nn.Module):
    def __init__(self, input_channels: int, output_channels: int):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Conv2d(input_channels, output_channels, 3, padding=1, bias=False),
            nn.BatchNorm2d(output_channels), nn.ReLU(inplace=True),
            nn.Conv2d(output_channels, output_channels, 3, padding=1, bias=False),
            nn.BatchNorm2d(output_channels), nn.ReLU(inplace=True),
        )

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.layers(inputs)


class UNet(nn.Module):
    def __init__(self, classes: int, base_channels: int = 32):
        super().__init__()
        self.enc1 = DoubleConv(3, base_channels)
        self.enc2 = DoubleConv(base_channels, base_channels * 2)
        self.enc3 = DoubleConv(base_channels * 2, base_channels * 4)
        self.bridge = DoubleConv(base_channels * 4, base_channels * 8)
        self.dec3 = DoubleConv(base_channels * 12, base_channels * 4)
        self.dec2 = DoubleConv(base_channels * 6, base_channels * 2)
        self.dec1 = DoubleConv(base_channels * 3, base_channels)
        self.head = nn.Conv2d(base_channels, classes, 1)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        enc1 = self.enc1(inputs)
        enc2 = self.enc2(F.max_pool2d(enc1, 2))
        enc3 = self.enc3(F.max_pool2d(enc2, 2))
        bridge = self.bridge(F.max_pool2d(enc3, 2))
        dec3 = self.dec3(torch.cat((F.interpolate(bridge, size=enc3.shape[-2:], mode="bilinear", align_corners=False), enc3), dim=1))
        dec2 = self.dec2(torch.cat((F.interpolate(dec3, size=enc2.shape[-2:], mode="bilinear", align_corners=False), enc2), dim=1))
        dec1 = self.dec1(torch.cat((F.interpolate(dec2, size=enc1.shape[-2:], mode="bilinear", align_corners=False), enc1), dim=1))
        return self.head(dec1)


class ResNetUNet(nn.Module):
    def __init__(self, classes: int, pretrained: bool):
        super().__init__()
        from torchvision.models import ResNet34_Weights, resnet34
        backbone = resnet34(weights=ResNet34_Weights.IMAGENET1K_V1 if pretrained else None)
        self.stem = nn.Sequential(backbone.conv1, backbone.bn1, backbone.relu)
        self.enc1 = nn.Sequential(backbone.maxpool, backbone.layer1)
        self.enc2, self.enc3, self.enc4 = backbone.layer2, backbone.layer3, backbone.layer4
        self.dec4 = DoubleConv(512 + 256, 256)
        self.dec3 = DoubleConv(256 + 128, 128)
        self.dec2 = DoubleConv(128 + 64, 64)
        self.dec1 = DoubleConv(64 + 64, 32)
        self.head = nn.Conv2d(32, classes, 1)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        stem = self.stem(inputs)
        enc1 = self.enc1(stem)
        enc2 = self.enc2(enc1)
        enc3 = self.enc3(enc2)
        enc4 = self.enc4(enc3)
        dec4 = self.dec4(torch.cat((F.interpolate(enc4, size=enc3.shape[-2:], mode="bilinear", align_corners=False), enc3), dim=1))
        dec3 = self.dec3(torch.cat((F.interpolate(dec4, size=enc2.shape[-2:], mode="bilinear", align_corners=False), enc2), dim=1))
        dec2 = self.dec2(torch.cat((F.interpolate(dec3, size=enc1.shape[-2:], mode="bilinear", align_corners=False), enc1), dim=1))
        dec1 = self.dec1(torch.cat((F.interpolate(dec2, size=stem.shape[-2:], mode="bilinear", align_corners=False), stem), dim=1))
        return F.interpolate(self.head(dec1), size=inputs.shape[-2:], mode="bilinear", align_corners=False)


class ASPP(nn.Module):
    def __init__(self, input_channels: int, output_channels: int):
        super().__init__()
        self.branches = nn.ModuleList([
            nn.Sequential(nn.Conv2d(input_channels, output_channels, 1, bias=False), nn.BatchNorm2d(output_channels), nn.ReLU(inplace=True)),
            *[nn.Sequential(nn.Conv2d(input_channels, output_channels, 3, padding=rate, dilation=rate, bias=False), nn.BatchNorm2d(output_channels), nn.ReLU(inplace=True)) for rate in (6, 12, 18)],
        ])
        self.project = nn.Sequential(nn.Conv2d(output_channels * 4, output_channels, 1, bias=False), nn.BatchNorm2d(output_channels), nn.ReLU(inplace=True))

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.project(torch.cat([branch(inputs) for branch in self.branches], dim=1))


class DeepLabV3Plus(nn.Module):
    def __init__(self, classes: int, backbone_name: str, pretrained: bool):
        super().__init__()
        from torchvision.models import ResNet50_Weights, ResNet101_Weights, resnet50, resnet101
        if "101" in backbone_name:
            backbone = resnet101(weights=ResNet101_Weights.IMAGENET1K_V2 if pretrained else None, replace_stride_with_dilation=[False, True, True])
        else:
            backbone = resnet50(weights=ResNet50_Weights.IMAGENET1K_V2 if pretrained else None, replace_stride_with_dilation=[False, True, True])
        self.stem = nn.Sequential(backbone.conv1, backbone.bn1, backbone.relu, backbone.maxpool)
        self.layer1, self.layer2, self.layer3, self.layer4 = backbone.layer1, backbone.layer2, backbone.layer3, backbone.layer4
        self.aspp = ASPP(2048, 256)
        self.low_projection = nn.Sequential(nn.Conv2d(256, 48, 1, bias=False), nn.BatchNorm2d(48), nn.ReLU(inplace=True))
        self.decoder = nn.Sequential(DoubleConv(304, 256), nn.Conv2d(256, classes, 1))

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        features = self.stem(inputs)
        low = self.layer1(features)
        features = self.layer4(self.layer3(self.layer2(low)))
        high = F.interpolate(self.aspp(features), size=low.shape[-2:], mode="bilinear", align_corners=False)
        return self.decoder(torch.cat((high, self.low_projection(low)), dim=1))


def build_segmentation_model(model_name: str, classes: int, weight_source: str = "scratch") -> nn.Module:
    pretrained = weight_source == "pretrained"
    configure_model_cache()
    if model_name.startswith("segformer"):
        from transformers import SegformerConfig, SegformerForSemanticSegmentation
        depth_map = {"b0": [2, 2, 2, 2], "b1": [2, 2, 2, 2], "b2": [3, 4, 6, 3], "b3": [3, 4, 18, 3], "b4": [3, 8, 27, 3], "b5": [3, 6, 40, 3]}
        variant = model_name.rsplit("-", 1)[-1]
        hidden_sizes = [32, 64, 160, 256] if variant == "b0" else [64, 128, 320, 512]
        if pretrained:
            try:
                source = Path(segformer_source(model_name))
                if source.is_file():
                    config = SegformerConfig(num_labels=classes, depths=depth_map.get(variant, depth_map["b0"]), hidden_sizes=hidden_sizes, decoder_hidden_size=256)
                    model = SegformerForSemanticSegmentation(config)
                    load_local_segformer_backbone(model, source)
                else:
                    model = SegformerForSemanticSegmentation.from_pretrained(
                        str(source) if source.exists() else segformer_source(model_name),
                        num_labels=classes,
                        ignore_mismatched_sizes=True,
                        local_files_only=os.environ.get("FORGE_PRETRAINED_OFFLINE", "false").lower() == "true",
                    )
            except Exception as error:
                raise explain_pretrained_failure(model_name, error) from error
        else:
            config = SegformerConfig(num_labels=classes, depths=depth_map.get(variant, depth_map["b0"]), hidden_sizes=hidden_sizes, decoder_hidden_size=256)
            model = SegformerForSemanticSegmentation(config)
        return SegmentationOutput(model, "segformer")
    if model_name.startswith("deeplabv3plus"):
        try:
            return SegmentationOutput(DeepLabV3Plus(classes, model_name, pretrained), "tensor")
        except Exception as error:
            if pretrained:
                raise explain_pretrained_failure(model_name, error) from error
            raise
    if model_name.startswith("unet"):
        try:
            return SegmentationOutput(ResNetUNet(classes, pretrained), "tensor")
        except Exception as error:
            if pretrained:
                raise explain_pretrained_failure(model_name, error) from error
            raise
    raise RuntimeError(f"Unsupported segmentation model: {model_name}")


class ResidualBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.layers = nn.Sequential(nn.Conv2d(channels, channels, 3, padding=1, bias=False), nn.BatchNorm2d(channels), nn.ReLU(inplace=True), nn.Conv2d(channels, channels, 3, padding=1, bias=False), nn.BatchNorm2d(channels))
        self.activation = nn.ReLU(inplace=True)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.activation(inputs + self.layers(inputs))


class HRNetKeypoint(nn.Module):
    def __init__(self, keypoints: int, channels: int, higher_resolution: bool):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(3, channels, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(channels), nn.ReLU(inplace=True), nn.Conv2d(channels, channels, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(channels), nn.ReLU(inplace=True))
        self.high = nn.Sequential(ResidualBlock(channels), ResidualBlock(channels))
        self.to_low = nn.Sequential(nn.Conv2d(channels, channels * 2, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(channels * 2), nn.ReLU(inplace=True))
        self.low = nn.Sequential(ResidualBlock(channels * 2), ResidualBlock(channels * 2))
        self.low_to_high = nn.Sequential(nn.Conv2d(channels * 2, channels, 1, bias=False), nn.BatchNorm2d(channels))
        self.fused = nn.Sequential(ResidualBlock(channels), ResidualBlock(channels))
        self.refine = nn.Sequential(nn.ConvTranspose2d(channels, channels, 4, stride=2, padding=1, bias=False), nn.BatchNorm2d(channels), nn.ReLU(inplace=True), ResidualBlock(channels)) if higher_resolution else nn.Identity()
        self.head = nn.Conv2d(channels, keypoints, 1)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        high = self.high(self.stem(inputs))
        low = self.low(self.to_low(high))
        fused = self.fused(high + F.interpolate(self.low_to_high(low), size=high.shape[-2:], mode="bilinear", align_corners=False))
        heatmaps = self.head(self.refine(fused))
        return F.interpolate(heatmaps, size=inputs.shape[-2:], mode="bilinear", align_corners=False)


class TimmHRNetKeypoint(nn.Module):
    def __init__(self, model_name: str, keypoints: int, pretrained: bool):
        super().__init__()
        import timm
        checkpoint = local_hrnet_checkpoint(model_name) if pretrained else None
        self.backbone = timm.create_model(
            timm_hrnet_source(model_name),
            pretrained=pretrained and checkpoint is None,
            checkpoint_path=str(checkpoint) if checkpoint else "",
            features_only=True,
            out_indices=(1, 2, 3, 4),
        )
        channels = 48 if model_name.endswith("w48") else 32
        self.projections = nn.ModuleList([
            nn.Sequential(nn.Conv2d(int(input_channels), channels, 1, bias=False), nn.BatchNorm2d(channels))
            for input_channels in self.backbone.feature_info.channels()
        ])
        self.fused = nn.Sequential(ResidualBlock(channels), ResidualBlock(channels))
        self.refine = nn.Sequential(
            nn.ConvTranspose2d(channels, channels, 4, stride=2, padding=1, bias=False),
            nn.BatchNorm2d(channels),
            nn.ReLU(inplace=True),
            ResidualBlock(channels),
        ) if model_name.startswith("higherhrnet") else nn.Identity()
        self.head = nn.Conv2d(channels, keypoints, 1)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        features = self.backbone(inputs)
        high_size = features[0].shape[-2:]
        projected = [projection(feature) for projection, feature in zip(self.projections, features)]
        fused = sum(F.interpolate(feature, size=high_size, mode="bilinear", align_corners=False) for feature in projected)
        heatmaps = self.head(self.refine(self.fused(fused)))
        return F.interpolate(heatmaps, size=inputs.shape[-2:], mode="bilinear", align_corners=False)


def build_keypoint_model(model_name: str, keypoints: int, weight_source: str = "scratch") -> nn.Module:
    if not model_name.startswith(("hrnet", "higherhrnet")):
        raise RuntimeError(f"Unsupported keypoint model: {model_name}")
    configure_model_cache()
    try:
        return TimmHRNetKeypoint(model_name, keypoints, weight_source == "pretrained")
    except Exception as error:
        if weight_source == "pretrained":
            raise explain_pretrained_failure(model_name, error) from error
        raise
