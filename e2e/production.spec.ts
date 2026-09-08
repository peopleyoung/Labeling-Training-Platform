import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://127.0.0.1:4000/api/v1';
const password = 'acceptance-user-password';
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function json(request: APIRequestContext, path: string, options: Parameters<APIRequestContext['fetch']>[1] = {}) {
  const response = await request.fetch(`${apiBase}${path}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status()} ${JSON.stringify(body)}`);
  return body as any;
}

async function login(request: APIRequestContext, username: string, userPassword: string) {
  return json(request, '/auth/login', { method: 'POST', data: { username, password: userPassword } });
}

async function loginPage(page: Page, username: string, userPassword: string) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/login');
  await page.getByRole('textbox', { name: '账号' }).fill(username);
  await page.getByRole('textbox', { name: '密码' }).fill(userPassword);
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/v1/auth/login') && response.request().method() === 'POST'),
    page.getByRole('button', { name: '登录工作空间' }).click(),
  ]);
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 30_000 });
}

test('production annotation loop works through the browser', async ({ page, request }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL || process.env.PLAYWRIGHT_PRODUCTION_ACCEPTANCE !== '1', 'only runs as an explicit production acceptance suite');
  const admin = await login(request, 'admin', 'acceptance-admin-password');
  const auth = { Authorization: `Bearer ${admin.accessToken}` };
  const catalog = await json(request, '/task-categories', { headers: auth });
  const taskType = await json(request, `/task-categories/${catalog.categories[0].id}/task-types`, { method: 'POST', headers: auth, data: { name: `浏览器测试业务-${Date.now()}` } });
  const suffix = Date.now();
  const annotatorName = `browser-annotator-${suffix}`;
  const reviewerName = `browser-reviewer-${suffix}`;
  await json(request, '/users', { method: 'POST', headers: auth, data: { username: annotatorName, displayName: '浏览器标注员', password, roles: ['annotator'] } });
  await json(request, '/users', { method: 'POST', headers: auth, data: { username: reviewerName, displayName: '浏览器审核员', password, roles: ['reviewer'] } });
  const dataset = await json(request, '/datasets', { method: 'POST', headers: auth, data: { taskTypeId: taskType.id, name: `浏览器流程-${suffix}`, description: 'production browser acceptance', version: 'v1', classes: ['defect'] } });
  const checksum = await crypto.subtle.digest('SHA-256', imageBytes).then((value) => Buffer.from(value).toString('hex'));
  const session = await json(request, `/datasets/${dataset.id}/upload-sessions`, { method: 'POST', headers: auth, data: { filename: 'browser.png', mimeType: 'image/png', sizeBytes: imageBytes.length, type: 'image', sha256: checksum } });
  await request.put(`${apiBase}/upload-sessions/${session.id}/parts/1`, { headers: { ...auth, 'content-type': 'application/octet-stream' }, data: imageBytes });
  await json(request, `/upload-sessions/${session.id}/complete`, { method: 'POST', headers: auth, data: { sha256: checksum } });
  const processing = await json(request, `/datasets/${dataset.id}/process`, { method: 'POST', headers: auth, data: { extractionStrategy: 'keyframe' } });
  let run;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    run = (await json(request, `/datasets/${dataset.id}/processing-runs`, { headers: auth })).items.find((item: any) => item.id === processing.id);
    if (['completed', 'failed', 'partial_failed'].includes(run?.status)) break;
  }
  expect(run?.status).toBe('completed');
  const images = (await json(request, `/datasets/${dataset.id}/images`, { headers: auth })).items;
  const jobs = (await json(request, `/datasets/${dataset.id}/jobs`, { headers: auth })).items;
  const annotator = await login(request, annotatorName, password);
  const claimed = await json(request, `/datasets/${dataset.id}/jobs/claim-next`, { method: 'POST', headers: { Authorization: `Bearer ${annotator.accessToken}` } });

  await loginPage(page, annotatorName, password);
  await page.goto(`/annotate/${dataset.id}?image=${images[0].id}`);
  await expect(page.getByRole('button', { name: '关键点' })).toBeVisible();
  await page.getByRole('button', { name: '关键点' }).click();
  const canvas = page.locator('.annotation-overlay');
  await canvas.click({ position: { x: 25, y: 25 } });
  await page.getByRole('button', { name: '保存全部' }).click();
  await expect(page.getByText('所有更改已同步')).toBeVisible();
  await page.getByRole('button', { name: '提交 Job' }).click();
  await expect(page.getByText('Job #1 · 待审核')).toBeVisible();

  const reviewer = await login(request, reviewerName, password);
  const reviewJob = await json(request, `/datasets/${dataset.id}/review-jobs/claim-next`, { method: 'POST', headers: { Authorization: `Bearer ${reviewer.accessToken}` } });
  expect(reviewJob.id).toBe(claimed.id);
  await loginPage(page, reviewerName, password);
  await page.goto(`/annotate/${dataset.id}?image=${images[0].id}&mode=review&job=${reviewJob.id}`);
  await expect(page.getByRole('button', { name: '通过当前' })).toBeEnabled();
  await page.getByRole('button', { name: '通过当前' }).click();
  await expect(page.getByText('当前 Segment 已进入已通过状态', { exact: true })).toBeVisible();

  const exportTask = await json(request, `/datasets/${dataset.id}/exports`, { method: 'POST', headers: { Authorization: `Bearer ${reviewer.accessToken}`, 'content-type': 'application/json' }, data: { format: 'COCO_KEYPOINTS', scope: 'all', versionName: 'browser-acceptance', includeImages: false, jobIds: [jobs[0].id] } });
  let exported;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    exported = (await json(request, `/datasets/${dataset.id}/exports`, { headers: { Authorization: `Bearer ${reviewer.accessToken}` } })).items.find((item: any) => item.id === exportTask.id);
    if (['completed', 'failed', 'cancelled'].includes(exported?.status)) break;
  }
  expect(exported?.status).toBe('completed');
  expect(exported?.artifactId).toBeTruthy();
  await json(request, `/datasets/${dataset.id}`, { method: 'DELETE', headers: { ...auth, 'x-confirm-resource-id': dataset.id } });
});
