import type { ConversionFormat, TrainingDataFormat, TrainingType } from './contracts';

export interface ModelCatalogItem {
  id: string;
  family: string;
  label: string;
  task: TrainingType;
  framework: string;
  variants: readonly string[];
  defaultVariant: string;
  defaultImageSize: number;
  minGpuMemoryGb: number;
  supportsMultiGpu: boolean;
  license: string;
  dataFormats: readonly TrainingDataFormat[];
}

export const modelCatalog = [
  { id: 'yolov5', family: 'yolov5', label: 'YOLOv5u', task: 'detection', framework: 'PyTorch / Ultralytics', variants: ['yolov5n', 'yolov5s', 'yolov5m', 'yolov5l', 'yolov5x'], defaultVariant: 'yolov5m', defaultImageSize: 640, minGpuMemoryGb: 4, supportsMultiGpu: true, license: 'AGPL-3.0', dataFormats: ['YOLO', 'COCO', 'VOC'] },
  { id: 'yolov8', family: 'yolov8', label: 'YOLOv8', task: 'detection', framework: 'PyTorch / Ultralytics', variants: ['yolov8n', 'yolov8s', 'yolov8m', 'yolov8l', 'yolov8x'], defaultVariant: 'yolov8m', defaultImageSize: 640, minGpuMemoryGb: 4, supportsMultiGpu: true, license: 'AGPL-3.0', dataFormats: ['YOLO', 'COCO', 'VOC'] },
  { id: 'yolov8-seg', family: 'yolov8-seg', label: 'YOLOv8-Seg', task: 'segmentation', framework: 'PyTorch / Ultralytics', variants: ['yolov8n-seg', 'yolov8s-seg', 'yolov8m-seg', 'yolov8l-seg', 'yolov8x-seg'], defaultVariant: 'yolov8m-seg', defaultImageSize: 640, minGpuMemoryGb: 4, supportsMultiGpu: true, license: 'AGPL-3.0', dataFormats: ['YOLO_SEGMENTATION'] },
  { id: 'yolov8-pose', family: 'yolov8-pose', label: 'YOLOv8-Pose', task: 'keypoint', framework: 'PyTorch / Ultralytics', variants: ['yolov8n-pose', 'yolov8s-pose', 'yolov8m-pose', 'yolov8l-pose', 'yolov8x-pose'], defaultVariant: 'yolov8m-pose', defaultImageSize: 640, minGpuMemoryGb: 4, supportsMultiGpu: true, license: 'AGPL-3.0', dataFormats: ['YOLO_KEYPOINTS'] },
  { id: 'segformer', family: 'segformer', label: 'SegFormer', task: 'segmentation', framework: 'PyTorch / Transformers', variants: ['segformer-b0', 'segformer-b1', 'segformer-b2', 'segformer-b3', 'segformer-b4', 'segformer-b5'], defaultVariant: 'segformer-b2', defaultImageSize: 512, minGpuMemoryGb: 8, supportsMultiGpu: true, license: 'Apache-2.0', dataFormats: ['COCO_SEGMENTATION', 'PNG_MASK'] },
  { id: 'unet', family: 'unet', label: 'U-Net', task: 'segmentation', framework: 'PyTorch / Forge Vision', variants: ['unet'], defaultVariant: 'unet', defaultImageSize: 512, minGpuMemoryGb: 6, supportsMultiGpu: true, license: 'MIT', dataFormats: ['COCO_SEGMENTATION', 'PNG_MASK'] },
  { id: 'deeplabv3plus', family: 'deeplabv3plus', label: 'DeepLabV3+', task: 'segmentation', framework: 'PyTorch / TorchVision', variants: ['deeplabv3plus-resnet50', 'deeplabv3plus-resnet101'], defaultVariant: 'deeplabv3plus-resnet50', defaultImageSize: 512, minGpuMemoryGb: 8, supportsMultiGpu: true, license: 'MIT', dataFormats: ['COCO_SEGMENTATION', 'PNG_MASK'] },
  { id: 'hrnet', family: 'hrnet', label: 'HRNet', task: 'keypoint', framework: 'PyTorch / Forge HRNet', variants: ['hrnet-w32', 'hrnet-w48'], defaultVariant: 'hrnet-w32', defaultImageSize: 384, minGpuMemoryGb: 8, supportsMultiGpu: true, license: 'Apache-2.0', dataFormats: ['COCO_KEYPOINTS'] },
  { id: 'higherhrnet', family: 'higherhrnet', label: 'HigherHRNet', task: 'keypoint', framework: 'PyTorch / Forge HRNet', variants: ['higherhrnet-w32', 'higherhrnet-w48'], defaultVariant: 'higherhrnet-w32', defaultImageSize: 512, minGpuMemoryGb: 12, supportsMultiGpu: true, license: 'Apache-2.0', dataFormats: ['COCO_KEYPOINTS'] },
  { id: 'sdxl-lora', family: 'sdxl', label: 'SDXL LoRA', task: 'sdxl', framework: 'PyTorch / Diffusers', variants: ['sdxl-1.0-lora'], defaultVariant: 'sdxl-1.0-lora', defaultImageSize: 1024, minGpuMemoryGb: 12, supportsMultiGpu: true, license: 'OpenRAIL++', dataFormats: ['IMAGE_FOLDER'] },
  { id: 'sdxl-dreambooth', family: 'sdxl', label: 'SDXL DreamBooth', task: 'sdxl', framework: 'PyTorch / Diffusers', variants: ['sdxl-1.0-dreambooth-lora'], defaultVariant: 'sdxl-1.0-dreambooth-lora', defaultImageSize: 1024, minGpuMemoryGb: 16, supportsMultiGpu: true, license: 'OpenRAIL++', dataFormats: ['IMAGE_FOLDER'] },
] as const satisfies readonly ModelCatalogItem[];

export const conversionCatalog: Record<ConversionFormat, { precisions: readonly string[]; targets: readonly string[] }> = {
  ONNX: { precisions: ['FP32', 'FP16'], targets: ['通用 CPU / GPU', 'NVIDIA GPU', 'Intel CPU'] },
  TensorRT: { precisions: ['FP32', 'FP16'], targets: ['NVIDIA T4', 'NVIDIA GPU'] },
  TorchScript: { precisions: ['FP32', 'FP16'], targets: ['PyTorch Runtime', 'NVIDIA GPU', 'CPU'] },
  OpenVINO: { precisions: ['FP32', 'FP16'], targets: ['Intel CPU', 'Intel GPU', 'Intel NPU'] },
};

export function findModelVariant(variant: string) {
  return modelCatalog.find((item) => item.variants.includes(variant as never));
}
