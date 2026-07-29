import argparse
import os
from pathlib import Path

import torch
from torch.nn import functional as F
from torch.utils.data import DataLoader

from .executor_common import emit, ensure_output_dir, sha256_file, write_json_artifact
from .training_data import SdxlImageDataset, load_manifest, split_images


def encode_prompts(tokenizers, text_encoders, prompts, device, dtype):
    embeddings = []
    pooled = None
    for tokenizer, text_encoder in zip(tokenizers, text_encoders):
        tokens = tokenizer(list(prompts), padding="max_length", max_length=tokenizer.model_max_length, truncation=True, return_tensors="pt")
        outputs = text_encoder(tokens.input_ids.to(device), output_hidden_states=True, return_dict=True)
        embeddings.append(outputs.hidden_states[-2])
        pooled = outputs.text_embeds if hasattr(outputs, "text_embeds") else outputs.pooler_output
    return torch.cat(embeddings, dim=-1).to(dtype=dtype), pooled.to(dtype=dtype)


def main() -> int:
    parser = argparse.ArgumentParser(description="Forge real SDXL LoRA trainer")
    parser.add_argument("--mode", required=True, choices=["lora", "dreambooth"])
    parser.add_argument("--data", required=True)
    parser.add_argument("--max-train-steps", required=True, type=int)
    parser.add_argument("--train-batch-size", required=True, type=int)
    parser.add_argument("--resolution", required=True, type=int)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--mixed-precision", required=True)
    parser.add_argument("--gradient-checkpointing", action="store_true")
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("SDXL LoRA training requires CUDA")
    base_model = Path(os.environ.get("FORGE_SDXL_BASE_MODEL", "/data/model-cache/stable-diffusion-xl-base-1.0"))
    if not base_model.is_dir():
        raise RuntimeError(f"SDXL base model is not available at {base_model}")

    from diffusers import AutoencoderKL, DDPMScheduler, StableDiffusionXLPipeline, UNet2DConditionModel
    from diffusers.utils import convert_state_dict_to_diffusers
    from peft import LoraConfig, get_peft_model_state_dict
    from transformers import AutoTokenizer, CLIPTextModel, CLIPTextModelWithProjection

    manifest = load_manifest(args.data, "sdxl")
    dataset = SdxlImageDataset(split_images(manifest, "train"), args.resolution)
    loader = DataLoader(dataset, batch_size=args.train_batch_size, shuffle=True, num_workers=0)
    output_dir = ensure_output_dir(args.output_dir)
    dtype = torch.float16 if args.mixed_precision == "fp16" else torch.bfloat16 if args.mixed_precision == "bf16" else torch.float32
    device = torch.device("cuda")
    tokenizer_one = AutoTokenizer.from_pretrained(base_model, subfolder="tokenizer", use_fast=False, local_files_only=True)
    tokenizer_two = AutoTokenizer.from_pretrained(base_model, subfolder="tokenizer_2", use_fast=False, local_files_only=True)
    text_encoder_one = CLIPTextModel.from_pretrained(base_model, subfolder="text_encoder", local_files_only=True).to(device, dtype=dtype).eval()
    text_encoder_two = CLIPTextModelWithProjection.from_pretrained(base_model, subfolder="text_encoder_2", local_files_only=True).to(device, dtype=dtype).eval()
    vae = AutoencoderKL.from_pretrained(base_model, subfolder="vae", local_files_only=True).to(device, dtype=torch.float32).eval()
    unet = UNet2DConditionModel.from_pretrained(base_model, subfolder="unet", local_files_only=True).to(device, dtype=dtype)
    scheduler = DDPMScheduler.from_pretrained(base_model, subfolder="scheduler", local_files_only=True)
    for module in (vae, text_encoder_one, text_encoder_two, unet):
        module.requires_grad_(False)
    if args.gradient_checkpointing:
        unet.enable_gradient_checkpointing()
    unet.add_adapter(LoraConfig(r=4, lora_alpha=4, init_lora_weights="gaussian", target_modules=["to_k", "to_q", "to_v", "to_out.0"]))
    trainable = [parameter for parameter in unet.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(trainable, lr=args.learning_rate)
    emit("progress", stage="prepare", progress=10, mode=args.mode, samples=len(dataset), baseModel=str(base_model))
    last_loss = 0.0
    step = 0
    while step < args.max_train_steps:
        for pixels, prompts in loader:
            pixels = pixels.to(device, dtype=torch.float32)
            if args.mode == "dreambooth":
                prompts = [f"a photo of sks industrial component, {prompt}" for prompt in prompts]
            with torch.no_grad():
                latents = vae.encode(pixels).latent_dist.sample() * vae.config.scaling_factor
                prompt_embeds, pooled = encode_prompts((tokenizer_one, tokenizer_two), (text_encoder_one, text_encoder_two), prompts, device, dtype)
            latents = latents.to(dtype=dtype)
            noise = torch.randn_like(latents)
            timesteps = torch.randint(0, scheduler.config.num_train_timesteps, (latents.shape[0],), device=device).long()
            noisy_latents = scheduler.add_noise(latents, noise, timesteps)
            add_time_ids = torch.tensor([[args.resolution, args.resolution, 0, 0, args.resolution, args.resolution]], device=device, dtype=dtype).repeat(latents.shape[0], 1)
            optimizer.zero_grad(set_to_none=True)
            prediction = unet(noisy_latents, timesteps, prompt_embeds, added_cond_kwargs={"text_embeds": pooled, "time_ids": add_time_ids}).sample
            target = scheduler.get_velocity(latents, noise, timesteps) if scheduler.config.prediction_type == "v_prediction" else noise
            loss = F.mse_loss(prediction.float(), target.float())
            loss.backward()
            optimizer.step()
            last_loss = float(loss.detach().cpu())
            step += 1
            emit("progress", stage="train", progress=min(90, 10 + round(step * 80 / args.max_train_steps)), step=step, loss=last_loss)
            if step >= args.max_train_steps:
                break
    state_dict = convert_state_dict_to_diffusers(get_peft_model_state_dict(unet))
    StableDiffusionXLPipeline.save_lora_weights(str(output_dir), unet_lora_layers=state_dict, safe_serialization=True)
    artifact = output_dir / "pytorch_lora_weights.safetensors"
    if not artifact.is_file() or artifact.stat().st_size == 0:
        raise RuntimeError("Diffusers did not produce SDXL LoRA weights")
    write_json_artifact(output_dir, "metrics.json", {"metricName": "Loss", "metricValue": last_loss, "epochs": args.max_train_steps})
    manifest_path = write_json_artifact(output_dir, "manifest.json", {"task": "sdxl", "mode": args.mode, "artifact": artifact.name, "sha256": sha256_file(artifact), "baseModel": str(base_model), "metrics": {"loss": last_loss}, "realTraining": True})
    emit("artifact", path=str(artifact), manifest=str(manifest_path), sha256=sha256_file(artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
