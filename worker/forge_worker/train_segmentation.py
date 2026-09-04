import json

import torch
from torch import nn
from torch.utils.data import DataLoader

from .executor_common import base_training_parser, emit, ensure_output_dir, sha256_file, write_json_artifact
from .pretrained import pretrained_source
from .training_data import SegmentationDataset, load_manifest, split_images
from .vision_models import build_segmentation_model


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


def main() -> int:
    parser = base_training_parser("Forge real segmentation trainer")
    args = parser.parse_args()
    manifest = load_manifest(args.data, "segmentation")
    classes = list(manifest["classes"])
    data_format = str(manifest.get("dataFormat") or "INTERNAL")
    class_count = len(classes) + 1
    device = torch.device("cuda" if torch.cuda.is_available() and args.device != "cpu" else "cpu")
    output_dir = ensure_output_dir(args.output_dir)
    train_loader = DataLoader(SegmentationDataset(split_images(manifest, "train"), classes, args.image_size), batch_size=args.batch_size, shuffle=True, num_workers=0)
    validation_loader = DataLoader(SegmentationDataset(split_images(manifest, "validation"), classes, args.image_size), batch_size=args.batch_size, num_workers=0)
    model = build_segmentation_model(args.model, class_count, args.weight_source).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    scaler = torch.amp.GradScaler("cuda", enabled=args.fp16 and device.type == "cuda")
    criterion = nn.CrossEntropyLoss()
    loaded_source = pretrained_source(args.model) if args.weight_source == "pretrained" else None
    emit("progress", stage="prepare", progress=10, model=args.model, samples=len(train_loader.dataset), device=str(device), dataFormat=data_format, weightSource=args.weight_source, pretrainedSource=loaded_source)
    last_loss = 0.0
    metric = 0.0
    for epoch in range(args.epochs):
        model.train()
        for images, masks in train_loader:
            images, masks = images.to(device), masks.to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=scaler.is_enabled()):
                loss = criterion(model(images), masks)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            last_loss = float(loss.detach().cpu())
        model.eval()
        scores = []
        with torch.no_grad():
            for images, masks in validation_loader:
                scores.append(mean_iou(model(images.to(device)).cpu(), masks, class_count))
        metric = float(sum(scores) / len(scores)) if scores else 0.0
        emit("progress", stage="train", progress=min(85, 15 + round((epoch + 1) * 70 / args.epochs)), epoch=epoch + 1, loss=last_loss, mIoU=metric)
    export_model = model.to("cpu").eval()
    artifact = output_dir / "model.torchscript.pt"
    torch.jit.trace(export_model, torch.randn(1, 3, args.image_size, args.image_size), strict=False).save(str(artifact))
    write_json_artifact(output_dir, "metrics.json", {"metricName": "mIoU", "metricValue": metric, "epochs": args.epochs, "loss": last_loss})
    manifest_path = write_json_artifact(output_dir, "manifest.json", {"task": "segmentation", "model": args.model, "dataFormat": data_format, "artifact": artifact.name, "sha256": sha256_file(artifact), "classes": ["background", *classes], "inputShape": [1, 3, args.image_size, args.image_size], "weightSource": args.weight_source, "pretrainedSource": loaded_source, "metrics": {"mIoU": metric, "loss": last_loss}, "realTraining": True})
    emit("artifact", path=str(artifact), manifest=str(manifest_path), sha256=sha256_file(artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
