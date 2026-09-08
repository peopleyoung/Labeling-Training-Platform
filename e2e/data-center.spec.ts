import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`data center tree and directory at ${viewport.width}px`, async ({ page }, testInfo) => {
    test.skip(!process.env.PLAYWRIGHT_BASE_URL && process.env.VITE_API_ENABLED !== 'true', 'requires API mode to exercise the administrator route');
    await page.setViewportSize(viewport);
    const user = { id: 'admin', role: 'admin', roles: ['admin'], displayName: '管理员', username: 'admin', enabled: true, mustChangePassword: false };
    await page.addInitScript((user) => localStorage.setItem('forge-ai-session', JSON.stringify({ user, accessToken: 'browser-test' })), user);
    const category = { id: 'c1', code: 'detection-code', name: '目标检测', description: '', sortOrder: 0, enabled: true, createdAt: '2026-09-08T00:00:00Z', datasetCount: 1 };
    const task = { ...category, id: 't1', code: 'vehicle-code', name: '城市道路车辆检测', categoryId: 'c1' };
    const dataset = { id: 'd1', taskTypeId: 't1', name: '城市道路车辆数据集', description: '白天路口', version: 'v1.0', classes: ['汽车', '货车'], createdAt: '2026-09-08T10:00:00Z', approvedAt: '2026-09-08T12:00:00Z', updatedAt: '', status: '可训练', images: 1280, annotated: 1280, size: '256 MB' };
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      let body: unknown = { items: [] };
      if (url.pathname.endsWith('/auth/me')) body = user;
      if (url.pathname.endsWith('/task-categories')) body = { categories: [category], taskTypes: [task] };
      if (url.pathname.endsWith('/data-center/tree')) body = { categories: [category], taskTypes: [task], items: [dataset], total: 1, page: 1, pageSize: 20 };
      if (url.pathname.endsWith('/capabilities')) body = { gpuEnabled: false, cpuTrainingEnabled: true, cpuOnnxEnabled: true, cpuConversionFormats: ['ONNX'] };
      await route.fulfill({ json: body });
    });
    await page.goto('/datasets');
    await expect(page.getByRole('heading', { name: '数据中心', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /城市道路车辆检测/ }).click();
    await expect(page.getByRole('button', { name: /城市道路车辆数据集/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('tree.png'), fullPage: true });
    await page.getByRole('button', { name: /城市道路车辆数据集/ }).click();
    await expect(page.getByText('审核完成时间', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建导出' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('details.png'), fullPage: true });
    await page.goto('/admin/task-catalog');
    await expect(page.getByRole('button', { name: '编辑城市道路车辆检测' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('catalog.png'), fullPage: true });
    await page.getByRole('button', { name: '编辑目标检测' }).click();
    await expect(page.getByLabel('编码')).toHaveAttribute('readonly', '');
    expect(errors).toEqual([]);
  });
}
