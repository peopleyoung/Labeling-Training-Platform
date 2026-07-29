import { expect, test } from '@playwright/test';

test('a clean workspace exposes capabilities without sample records', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  await expect(page.getByRole('banner').getByText('CPU Worker 已启用', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无训练任务')).toBeVisible();
  await expect(page.getByText('暂无数据集')).toBeVisible();

  await page.goto('/datasets');
  await expect(page.getByText('暂无数据集')).toBeVisible();

  await page.goto('/training');
  await expect(page.getByText('暂无训练任务')).toBeVisible();

  await page.goto('/models');
  await expect(page.getByText('暂无模型版本')).toBeVisible();

  await page.goto('/conversions');
  await expect(page.getByText('暂无源模型')).toBeVisible();
  await expect(page.getByText('暂无转换任务')).toBeVisible();
  await expect(page.getByText('CPU 模式支持 FP32 ONNX、TorchScript 与 OpenVINO')).toBeVisible();
  await page.getByRole('button', { name: /^ONNX/ }).click();
  await expect(page.locator('.conversion-config header')).toContainText('ONNX 配置');
  await expect(page.getByRole('button', { name: /^TensorRT/ })).toBeDisabled();
  for (const format of ['TorchScript', 'OpenVINO']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${format}`) })).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: '创建转换任务' })).toBeDisabled();
});

test('training wizard blocks submission until a real dataset exists', async ({ page }) => {
  await page.goto('/training/new');
  await expect(page.getByText('CPU 训练模式')).toBeVisible();
  for (const taskName of ['目标检测', '语义分割', '关键点检测', 'SDXL 微调']) {
    await expect(page.getByRole('button', { name: new RegExp(taskName) })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /SDXL 微调/ })).toBeDisabled();
  await page.getByRole('button', { name: /语义分割/ }).click();
  await page.getByRole('button', { name: /下一步/ }).click();
  await expect(page.getByRole('combobox', { name: '基础模型' })).toHaveValue('segformer-b0');
  await expect(page.getByRole('combobox', { name: '权重来源' })).toHaveValue('pretrained');
  await expect(page.locator('.dataset-snapshot').getByText('暂无可训练数据集')).toBeVisible();
  await expect(page.getByRole('button', { name: /下一步/ })).toBeDisabled();

  await page.goto('/annotate/missing-dataset');
  await expect(page.getByRole('heading', { name: '请选择数据集图像' })).toBeVisible();
});

test('dashboard remains navigable without horizontal overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasOverflow).toBe(false);
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect.poll(() => page.locator('.sidebar').evaluate((element) => Math.round(element.getBoundingClientRect().x))).toBe(0);
});
