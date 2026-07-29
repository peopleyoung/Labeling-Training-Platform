# Compute Workers

Both compute workers consume BullMQ tasks through the Node process and run Python adapters in `forge_worker`.

The default `cpu-worker` consumes `forge-cpu` without requiring NVIDIA hardware. YOLOv5u/YOLOv8 detection, SegFormer/U-Net/DeepLabV3+ segmentation, and HRNet/HigherHRNet keypoint jobs perform real optimization on CPU. CPU conversion supports FP32 ONNX, TorchScript, and OpenVINO. TensorRT remains CUDA-only.

The optional GPU worker image targets CUDA 12.1 and NVIDIA T4 16GB and consumes `forge-gpu`.

The GPU product profile enables FP16 by default. SDXL uses LoRA or DreamBooth LoRA with batch size 1 and gradient checkpointing against a preseeded local Base model. Full-parameter SDXL training is intentionally rejected on the T4 profile. ControlNet is unavailable until paired conditioning-image data is modeled.

Real training adapters:

- YOLOv5u n/s/m/l/x through the pinned Ultralytics CLI
- YOLOv8 n/s/m/l/x through the pinned Ultralytics CLI
- SegFormer, U-Net, and DeepLabV3+ through the PyTorch segmentation runner
- HRNet and HigherHRNet through the PyTorch Gaussian-heatmap runner
- SDXL LoRA and DreamBooth LoRA through Diffusers, PEFT, and Accelerate

YOLO conversions call `Ultralytics.YOLO.export`. Structured vision TorchScript artifacts use the generic PyTorch exporter. SDXL conversion fuses LoRA into the configured Base and exports the UNet component. ONNX graphs are checked, OpenVINO XML and BIN files are delivered together as a ZIP, and TensorRT engines must be built on the target-compatible NVIDIA runtime.

Uploaded plain state dictionaries cannot be reconstructed without model-family lineage. Prefer a model produced by a platform training job, or identify an uploaded model framework as YOLOv5/YOLOv8. Pretrained weights are cached under `FORGE_MODEL_CACHE` (default `/data/model-cache`). SegFormer uses NVIDIA MiT checkpoints, U-Net/DeepLabV3+ use TorchVision ImageNet ResNet encoders, and HRNet/HigherHRNet use timm ImageNet HRNet backbones. Set `weightSource=scratch` for random initialization.

Run `PYTHONPATH=/app/worker python3 -m forge_worker.prefetch_models` inside either Worker image to download and validate all structured-vision pretrained weights in one pass. Set `FORGE_PRETRAINED_OFFLINE=true` after the cache is populated to prevent runtime model-hub access; a missing cache then fails explicitly instead of falling back to scratch.

Run `PYTHONPATH=worker python3 -m forge_worker.acceptance_smoke` in a Worker environment to exercise real SegFormer, DeepLabV3+, HRNet, and HigherHRNet training plus ONNX validation using temporary data. Add `--all-cpu-formats` to validate TorchScript and OpenVINO packaging too.
