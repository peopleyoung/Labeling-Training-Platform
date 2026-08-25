from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import torch
from PIL import Image

from forge_worker.training_data import SegmentationDataset
from forge_worker.vision_models import build_segmentation_model


class RkSegmentationTrainingTest(unittest.TestCase):
    def test_rk_variant_uses_official_stride_eight_topology(self) -> None:
        model = build_segmentation_model(
            "deeplabv3plus-mobilenetv2-rk",
            classes=3,
            weight_source="scratch",
            image_size=128,
        )
        model.eval()

        with torch.no_grad():
            output = model(torch.zeros(1, 3, 128, 128))

        self.assertEqual(tuple(output.shape), (1, 3, 16, 16))
        self.assertEqual(model.encoder.output_stride, 8)
        self.assertEqual(model.encoder.out_channels[-1], 320)
        self.assertEqual(len(model.encoder.features), 18)
        self.assertEqual(model.decoder.image_pool.kernel_size, (16, 16))
        self.assertEqual(model.decoder.aspp_projection[0].in_channels, 320)
        self.assertFalse(hasattr(model.decoder, "up"))
        self.assertFalse(hasattr(model.decoder, "block1"))
        self.assertFalse(hasattr(model.decoder, "block2"))

    def test_rk_dataset_normalizes_rgb_pixels_to_minus_one_one(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "sample.png"
            Image.new("RGB", (1, 1), (0, 127, 255)).save(image_path)
            dataset = SegmentationDataset(
                [{"path": str(image_path), "annotations": []}],
                classes=["defect"],
                image_size=1,
                normalization="rknn",
            )

            image, mask = dataset[0]

        expected = torch.tensor([-1.0, (127.0 - 127.5) / 127.5, 1.0])
        torch.testing.assert_close(image[:, 0, 0], expected)
        self.assertEqual(tuple(mask.shape), (1, 1))


if __name__ == "__main__":
    unittest.main()
