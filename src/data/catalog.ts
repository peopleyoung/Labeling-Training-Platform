import type { TrainingDataFormat, TrainingType } from '../types';

export const taskLabels = {
  detection: '目标检测',
  segmentation: '语义分割',
  keypoint: '关键点检测',
  sdxl: 'SDXL 微调',
} as const;

export const dataFormatDescriptions = {
  YOLO: { label: 'YOLO TXT', description: '图像与归一化标签，适用于 YOLOv5 / YOLOv8', task: 'detection' },
  COCO: { label: 'COCO Detection', description: '统一 JSON 中保存检测框与类别', task: 'detection' },
  VOC: { label: 'Pascal VOC', description: '每张图像对应一个边界框 XML', task: 'detection' },
  YOLO_SEGMENTATION: { label: 'YOLO Segmentation TXT', description: 'YOLO 实例分割多边形标签，适用于 YOLOv8-Seg', task: 'segmentation' },
  COCO_SEGMENTATION: { label: 'COCO Segmentation', description: 'COCO JSON 多边形与区域分割标注', task: 'segmentation' },
  PNG_MASK: { label: 'PNG Mask', description: '索引 PNG 掩码与类别映射', task: 'segmentation' },
  YOLO_KEYPOINTS: { label: 'YOLO Pose TXT', description: 'YOLO 姿态边框、关键点和可见性标签，适用于 YOLOv8-Pose', task: 'keypoint' },
  COCO_KEYPOINTS: { label: 'COCO Keypoints', description: '每张图像一个编号关键点实例', task: 'keypoint' },
  IMAGE_FOLDER: { label: 'Image Folder + Prompt', description: 'SDXL 图像与提示词目录', task: 'sdxl' },
  CVAT_JSON: { label: 'CVAT JSON', description: 'CVAT 1.1 JSON 交换格式，保留帧与资源元数据', task: 'detection' },
  CVAT_XML: { label: 'CVAT XML', description: 'CVAT 1.1 XML 交换格式，适用于 CVAT 导入', task: 'detection' },
} as const satisfies Record<TrainingDataFormat, { label: string; description: string; task: TrainingType }>;

export const formatDescriptions = {
  ONNX: { description: '跨框架通用部署格式', target: '通用 CPU / GPU', defaultPrecision: 'FP32' },
  TensorRT: { description: 'NVIDIA GPU 高性能推理', target: 'NVIDIA T4', defaultPrecision: 'FP16' },
  TorchScript: { description: 'PyTorch 原生部署产物', target: 'PyTorch Runtime', defaultPrecision: 'FP32' },
  OpenVINO: { description: 'Intel 硬件优化推理', target: 'Intel CPU', defaultPrecision: 'FP16' },
} as const;
