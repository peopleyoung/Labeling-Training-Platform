import json

import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader

from .executor_common import base_training_parser, emit, ensure_output_dir, sha256_file, write_json_artifact
from .pretrained import pretrained_source
from .training_data import SegmentationDataset, load_manifest, split_images
from .vision_models import RK_SEGMENTATION_MODEL, build_segmentation_model


def mean_iou(logits: torch.Tensor, targets: torch.Tensor, classes: int) -> float:
    predictions = logits.argmax(dim=1)
    values = []
    for class_id in range(1, classes):
        predicted = predictions == class_id
        actual = targets == class_id
        union = (predicted | actual).sum().item()
        if union:
            values.append((predicted & actual).sum().item() / union)
    return float(sum(values) / len(values)) if values else 0.0


def deployment_logits_for_loss(logits: torch.Tensor, masks: torch.Tensor) -> torch.Tensor:
    if logits.shape[-2:] == masks.shape[-2:]:
        return logits
    return F.interpolate(logits, size=masks.shape[-2:], mode="bilinear", align_corners=False)


def freeze_batch_norm(model: nn.Module) -> None:
    for module in model.modules():
        if isinstance(module, nn.modules.batchnorm._BatchNorm):
            module.eval()


def main() -> int:
    parser = base_training_parser("Forge real segmentation trainer")
    args = parser.parse_args()
    manifest = load_manifest(args.data, "segmentation")
    classes = list(manifest["classes"])
    data_format = str(manifest.get("dataFormat") or "INTERNAL")
    class_count = len(classes) + 1
    device = torch.device("cuda" if torch.cuda.is_available() and args.device != "cpu" else "cpu")
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    output_dir = ensure_output_dir(args.output_dir)
    rk_variant = args.model == RK_SEGMENTATION_MODEL
    normalization = "rknn" if rk_variant else "imagenet"
    train_dataset = SegmentationDataset(split_images(manifest, "train"), classes, args.image_size, normalization)
    validation_dataset = SegmentationDataset(split_images(manifest, "validation"), classes, args.image_size, normalization)
    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True, num_workers=0)
    validation_loader = DataLoader(validation_dataset, batch_size=args.batch_size, num_workers=0)
    model = build_segmentation_model(args.model, class_count, args.weight_source, args.image_size).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    scaler = torch.amp.GradScaler("cuda", enabled=args.fp16 and device.type == "cuda")
    criterion = nn.CrossEntropyLoss()
    freeze_singleton_batch_norm = min(args.batch_size, len(train_dataset)) == 1
    loaded_source = pretrained_source(args.model) if args.weight_source == "pretrained" else None
    emit("progress", stage="prepare", progress=10, model=args.model, architectureVariant=args.architecture_variant, samples=len(train_loader.dataset), device=str(device), dataFormat=data_format, weightSource=args.weight_source, pretrainedSource=loaded_source)
    checkpoint = output_dir / "best.pth"
    best_validation_loss = float("inf")
    best_metric = 0.0
    last_loss = 0.0
    metric = 0.0
    for epoch in range(args.epochs):
        model.train()
        if freeze_singleton_batch_norm:
            freeze_batch_norm(model)
        for images, masks in train_loader:
            images, masks = images.to(device), masks.to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=scaler.is_enabled()):
                deployment_logits = model(images)
                logits = deployment_logits_for_loss(deployment_logits, masks)
                loss = criterion(logits, masks)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            last_loss = float(loss.detach().cpu())
        model.eval()
        scores = []
        validation_losses = []
        with torch.no_grad():
            for images, masks in validation_loader:
                images, masks = images.to(device), masks.to(device)
                deployment_logits = model(images)
                logits = deployment_logits_for_loss(deployment_logits, masks)
                validation_losses.append(float(criterion(logits, masks).detach().cpu()))
                scores.append(mean_iou(logits, masks, class_count))
        validation_loss = float(sum(validation_losses) / len(validation_losses)) if validation_losses else last_loss
        metric = float(sum(scores) / len(scores)) if scores else 0.0
        if validation_loss < best_validation_loss:
            best_validation_loss = validation_loss
            best_metric = metric
            torch.save(model.state_dict(), checkpoint)
        emit("progress", stage="train", progress=min(85, 15 + round((epoch + 1) * 70 / args.epochs)), epoch=epoch + 1, loss=last_loss, validationLoss=validation_loss, mIoU=metric)
    model.load_state_dict(torch.load(checkpoint, map_location=device, weights_only=True))
    metric = best_metric
    export_model = model.to("cpu").eval()
    artifact = output_dir / "model.torchscript.pt"
    torch.jit.trace(export_model, torch.randn(1, 3, args.image_size, args.image_size), strict=False).save(str(artifact))
    write_json_artifact(output_dir, "metrics.json", {"metricName": "mIoU", "metricValue": metric, "epochs": args.epochs, "loss": last_loss, "validationLoss": best_validation_loss})
    output_size = (args.image_size + 7) // 8 if rk_variant else args.image_size
    preprocessing = {
        "colorSpace": "RGB",
        "resize": "stretch",
        "normalization": "pixel_minus_127_5_div_127_5" if rk_variant else "imagenet_mean_std",
    }
    manifest_path = write_json_artifact(output_dir, "manifest.json", {"task": "segmentation", "model": args.model, "architectureVariant": args.architecture_variant, "targetFamily": "rockchip_npu" if args.architecture_variant == "rk_compatible" else "general_runtime", "outputProtocol": "segmentation_logits", "dataFormat": data_format, "artifact": artifact.name, "checkpoint": checkpoint.name, "sha256": sha256_file(artifact), "classes": ["background", *classes], "inputShape": [1, 3, args.image_size, args.image_size], "outputShape": [1, class_count, output_size, output_size], "outputStride": 8 if rk_variant else 1, "preprocessing": preprocessing, "weightSource": args.weight_source, "pretrainedSource": loaded_source, "metrics": {"mIoU": metric, "loss": last_loss, "validationLoss": best_validation_loss}, "realTraining": True})
    emit("artifact", path=str(artifact), manifest=str(manifest_path), sha256=sha256_file(artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
