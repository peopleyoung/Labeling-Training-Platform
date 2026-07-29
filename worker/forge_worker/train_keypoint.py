import torch
from torch import nn
from torch.utils.data import DataLoader

from .executor_common import base_training_parser, emit, ensure_output_dir, sha256_file, write_json_artifact
from .pretrained import pretrained_source
from .training_data import KeypointDataset, load_manifest, split_images
from .vision_models import build_keypoint_model


def oks_score(predictions: torch.Tensor, targets: torch.Tensor, visible: torch.Tensor) -> float:
    batch, keypoints, _, width = predictions.shape
    predicted_index = predictions.flatten(2).argmax(dim=2)
    target_index = targets.flatten(2).argmax(dim=2)
    predicted_xy = torch.stack((predicted_index % width, predicted_index // width), dim=-1).float()
    target_xy = torch.stack((target_index % width, target_index // width), dim=-1).float()
    distances = ((predicted_xy - target_xy) ** 2).sum(dim=-1)
    scores = torch.exp(-distances / (2 * (0.05 * width) ** 2))
    selected = scores[visible.reshape(batch, keypoints)]
    return float(selected.mean()) if selected.numel() else 0.0


def main() -> int:
    parser = base_training_parser("Forge real HRNet keypoint trainer")
    args = parser.parse_args()
    manifest = load_manifest(args.data, "keypoint")
    keypoint_count = int(manifest["keypointCount"])
    data_format = str(manifest.get("dataFormat") or "INTERNAL")
    device = torch.device("cuda" if torch.cuda.is_available() and args.device != "cpu" else "cpu")
    output_dir = ensure_output_dir(args.output_dir)
    train_loader = DataLoader(KeypointDataset(split_images(manifest, "train"), keypoint_count, args.image_size), batch_size=args.batch_size, shuffle=True, num_workers=0)
    validation_loader = DataLoader(KeypointDataset(split_images(manifest, "validation"), keypoint_count, args.image_size), batch_size=args.batch_size, num_workers=0)
    model = build_keypoint_model(args.model, keypoint_count, args.weight_source).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    scaler = torch.amp.GradScaler("cuda", enabled=args.fp16 and device.type == "cuda")
    criterion = nn.MSELoss()
    loaded_source = pretrained_source(args.model) if args.weight_source == "pretrained" else None
    emit("progress", stage="prepare", progress=10, model=args.model, samples=len(train_loader.dataset), keypoints=keypoint_count, device=str(device), dataFormat=data_format, weightSource=args.weight_source, pretrainedSource=loaded_source)
    last_loss = 0.0
    metric = 0.0
    for epoch in range(args.epochs):
        model.train()
        for images, heatmaps, _ in train_loader:
            images, heatmaps = images.to(device), heatmaps.to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=scaler.is_enabled()):
                loss = criterion(model(images), heatmaps)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            last_loss = float(loss.detach().cpu())
        model.eval()
        scores = []
        with torch.no_grad():
            for images, heatmaps, visible in validation_loader:
                scores.append(oks_score(model(images.to(device)).cpu(), heatmaps, visible))
        metric = float(sum(scores) / len(scores)) if scores else 0.0
        emit("progress", stage="train", progress=min(85, 15 + round((epoch + 1) * 70 / args.epochs)), epoch=epoch + 1, loss=last_loss, oks=metric)
    artifact = output_dir / "model.torchscript.pt"
    torch.jit.trace(model.to("cpu").eval(), torch.randn(1, 3, args.image_size, args.image_size), strict=False).save(str(artifact))
    write_json_artifact(output_dir, "metrics.json", {"metricName": "OKS", "metricValue": metric, "epochs": args.epochs, "loss": last_loss})
    manifest_path = write_json_artifact(output_dir, "manifest.json", {"task": "keypoint", "model": args.model, "dataFormat": data_format, "artifact": artifact.name, "sha256": sha256_file(artifact), "keypointCount": keypoint_count, "inputShape": [1, 3, args.image_size, args.image_size], "weightSource": args.weight_source, "pretrainedSource": loaded_source, "metrics": {"OKS": metric, "loss": last_loss}, "realTraining": True})
    emit("artifact", path=str(artifact), manifest=str(manifest_path), sha256=sha256_file(artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
