import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationDocument } from '../types';
import { AnnotationPage } from './AnnotationPage';

const mocks = vi.hoisted(() => ({
  loadAnnotationDocument: vi.fn(), saveAnnotationDocument: vi.fn(), datasetImages: vi.fn(), annotationJobs: vi.fn(), annotationSegments: vi.fn(), claimNextAnnotationJob: vi.fn(), claimAnnotationReviewJob: vi.fn(), claimNextAnnotationReviewJob: vi.fn(), submitAnnotationJob: vi.fn(), reviewAnnotationJob: vi.fn(), saveReviewedAnnotation: vi.fn(), datasetImagePreview: vi.fn(), notify: vi.fn(), logout: vi.fn(),
  session: { accessToken: 'test-token', user: { id: 'tester', workspaceId: 'test', username: 'annotator', displayName: 'Annotator', role: 'annotator', mustChangePassword: false } },
}));

const images = [
  { id: 'image-1', datasetId: 'dataset-1', filename: 'image-1.png', mimeType: 'image/png', sizeBytes: 10, split: 'train' as const, createdAt: '2026-07-27T00:00:00.000Z' },
  { id: 'image-2', datasetId: 'dataset-1', filename: 'image-2.png', mimeType: 'image/png', sizeBytes: 10, split: 'train' as const, createdAt: '2026-07-27T00:00:00.000Z' },
];

vi.mock('../context/AppContext', () => ({ useApp: () => ({
  datasets: [{ id: 'dataset-1', name: 'Test', description: '', version: 'v1', type: '目标检测', images: 2, annotated: 0, classes: ['defect'], labels: [{ name: 'defect', color: '#1890ff', attributes: [] }, { name: 'scratch', color: '#52c41a', attributes: [] }], updatedAt: '2026-07-27T00:00:00.000Z', size: '20 B', status: '标注中' }],
  datasetImages: mocks.datasetImages, annotationJobs: mocks.annotationJobs, annotationSegments: mocks.annotationSegments, claimNextAnnotationJob: mocks.claimNextAnnotationJob, claimAnnotationReviewJob: mocks.claimAnnotationReviewJob, claimNextAnnotationReviewJob: mocks.claimNextAnnotationReviewJob, submitAnnotationJob: mocks.submitAnnotationJob, reviewAnnotationJob: mocks.reviewAnnotationJob, saveReviewedAnnotation: mocks.saveReviewedAnnotation, datasetImagePreview: mocks.datasetImagePreview, loadAnnotationDocument: mocks.loadAnnotationDocument, saveAnnotationDocument: mocks.saveAnnotationDocument, session: mocks.session, notify: mocks.notify, logout: mocks.logout,
}) }));

function renderPage(entry = '/annotate/dataset-1?image=image-1') {
  return render(<MemoryRouter initialEntries={[entry]}><Routes><Route path="/annotate/:datasetId" element={<AnnotationPage />} /><Route path="/annotate/:datasetId/job/:jobId" element={<AnnotationPage />} /><Route path="/datasets" element={<div data-testid="datasets-page">数据中心</div>} /></Routes></MemoryRouter>);
}

function expectObjectCount(count: number) {
  expect(screen.getByRole('button', { name: `对象 ${count}` })).toBeInTheDocument();
}

describe('Reference annotation workbench', () => {
  beforeEach(() => {
    mocks.session.user.role = 'annotator';
    mocks.loadAnnotationDocument.mockReset().mockImplementation(async (datasetId: string, imageId: string): Promise<AnnotationDocument> => ({ datasetId, imageId, revision: 0, annotations: [], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' }));
    mocks.saveAnnotationDocument.mockReset().mockImplementation(async (input: Pick<AnnotationDocument, 'datasetId' | 'imageId' | 'revision' | 'annotations' | 'captions' | 'imageAttributes'>): Promise<AnnotationDocument> => ({ ...input, revision: input.revision + 1, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' }));
    mocks.datasetImages.mockReset().mockResolvedValue(images); mocks.annotationJobs.mockReset().mockResolvedValue([]); mocks.annotationSegments.mockReset().mockResolvedValue([]); mocks.claimNextAnnotationJob.mockReset(); mocks.claimAnnotationReviewJob.mockReset(); mocks.claimNextAnnotationReviewJob.mockReset(); mocks.submitAnnotationJob.mockReset(); mocks.reviewAnnotationJob.mockReset(); mocks.saveReviewedAnnotation.mockReset(); mocks.datasetImagePreview.mockReset().mockResolvedValue('data:image/png;base64,iVBORw0KGgo='); mocks.notify.mockReset(); mocks.logout.mockReset();
  });

  afterEach(() => cleanup());

  it('renders the reference shell and frame navigation', async () => {
    renderPage();
    expect(await screen.findByTestId('reference-workbench')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '矩形' })).toBeInTheDocument();
    expect(mocks.claimNextAnnotationJob).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '返回数据中心' })).toHaveAttribute('href', '/datasets');
    const playback = document.querySelector('.reference-playback')!;
    expect(playback.querySelector('.reference-playback-track')).toBeInTheDocument();
    expect(playback.querySelector('.filename')).toHaveTextContent('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await waitFor(() => expect(screen.getByText('image-2.png')).toBeInTheDocument());
  });

  it('waits for the next image before showing its annotation overlay', async () => {
    mocks.loadAnnotationDocument.mockImplementation(async (datasetId: string, imageId: string): Promise<AnnotationDocument> => ({ datasetId, imageId, revision: 1, annotations: [{ id: `${imageId}-box`, label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x: 10, y: 10, width: 20, height: 20 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' }));
    renderPage();
    const firstImage = await screen.findByRole('img', { name: '当前标注图像' });
    fireEvent.load(firstImage);
    await waitFor(() => expect(document.querySelector('.reference-canvas > svg')).toHaveStyle({ visibility: 'visible' }));

    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    const nextImage = await screen.findByRole('img', { name: '当前标注图像' });
    expect(nextImage).not.toBe(firstImage);
    expect(document.querySelector('.reference-canvas > svg')).toHaveStyle({ visibility: 'hidden' });
    fireEvent.load(nextImage);
    await waitFor(() => expect(document.querySelector('.reference-canvas > svg')).toHaveStyle({ visibility: 'visible' }));
  });

  it('uses the preview dimensions and keeps cursor annotations readable', async () => {
    mocks.loadAnnotationDocument.mockResolvedValue({ datasetId: 'dataset-1', imageId: 'image-1', revision: 1, annotations: [{ id: 'box-1', label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x: 10, y: 20, width: 30, height: 25 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' });
    renderPage();
    const image = await screen.findByRole('img', { name: '当前标注图像' });
    const svg = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(svg, 'clientWidth', { configurable: true, value: 960 });
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1920 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1080 });
    fireEvent.load(image);

    await waitFor(() => expect(svg).toHaveAttribute('viewBox', '0 0 1920 1080'));
    expect(document.querySelector('.reference-canvas')).toHaveStyle({ aspectRatio: '1920 / 1080' });
    expect(svg.querySelector('rect')).toHaveAttribute('x', '192');
    expect(svg.querySelector('rect')).toHaveAttribute('y', '216');
    expect(svg.querySelector('text')).toHaveStyle({ fontSize: '33.6px' });

    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭绘制配置' }));
    expect(screen.getByRole('button', { name: '光标' })).toHaveClass('active');
    expect(document.querySelector('.reference-canvas-area')).toHaveAttribute('data-tool', 'cursor');
    expect(document.querySelectorAll('.reference-handles circle')).toHaveLength(8);
    expect(document.querySelector('.reference-handles circle')).toHaveAttribute('r', '8');
  });

  it('keeps the selected drawing tool after completing a shape and moving to the next frame', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    const rectangleButton = screen.getByRole('button', { name: '矩形' });
    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });

    fireEvent.click(rectangleButton);
    expect(screen.getByRole('dialog', { name: '绘制新矩形' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开始绘制矩形' }));
    fireEvent.click(canvas, { detail: 1, clientX: 10, clientY: 10 });
    fireEvent.click(canvas, { detail: 1, clientX: 60, clientY: 60 });

    await waitFor(() => expectObjectCount(1));
    expect(rectangleButton).toHaveClass('active');
    fireEvent.click(canvas, { detail: 1, clientX: 20, clientY: 20 });
    fireEvent.click(canvas, { detail: 1, clientX: 70, clientY: 70 });
    await waitFor(() => expectObjectCount(2));
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await screen.findByText('image-2.png');
    expect(screen.getByRole('button', { name: '矩形' })).toHaveClass('active');
  });

  it('zooms the canvas with the mouse wheel and matches the reference canvas controls', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    const toolRail = document.querySelector('.reference-tool-rail')!;
    expect(toolRail.querySelector('[aria-label="移动画布"]')).toBeInTheDocument();
    expect(toolRail.querySelector('[aria-label="顺时针旋转"]')).toBeInTheDocument();
    expect(toolRail.querySelector('[aria-label="适应画布"]')).toBeInTheDocument();
    expect(toolRail.querySelector('[aria-label="调整画布大小"]')).not.toBeInTheDocument();

    fireEvent.wheel(document.querySelector('.reference-canvas-area')!, { deltaY: -100 });
    expect((document.querySelector('.reference-canvas') as HTMLElement).style.transform).toContain('scale(1.1)');
  });

  it('draws a polygon with the reference setup and live closed preview', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    const polygonButton = screen.getByRole('button', { name: '多边形' });
    fireEvent.click(polygonButton);

    expect(screen.getByRole('dialog', { name: '绘制新多边形' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '多边形标签' })).toHaveValue('defect');
    fireEvent.click(screen.getByRole('button', { name: '开始绘制多边形' }));

    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });
    fireEvent.click(canvas, { detail: 1, clientX: 10, clientY: 10 });
    fireEvent.click(canvas, { detail: 1, clientX: 80, clientY: 10 });
    fireEvent.click(canvas, { detail: 1, clientX: 50, clientY: 80 });

    await waitFor(() => expect(document.querySelector('.reference-polygon-draft')).toBeTruthy());
    expect(document.querySelectorAll('.reference-polygon-vertex')).toHaveLength(3);
    expect(screen.getByRole('button', { name: '完成多边形' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '完成多边形' }));
    await waitFor(() => expectObjectCount(1));
    expect(document.querySelector('.reference-polygon-draft')).not.toBeInTheDocument();
    expect(polygonButton).toHaveClass('active');
  });

  it('draws a polyline continuously with the reference setup', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });

    fireEvent.click(screen.getByRole('button', { name: '折线' }));
    expect(screen.getByRole('dialog', { name: '绘制新折线' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开始绘制折线' }));
    fireEvent.click(canvas, { detail: 1, clientX: 10, clientY: 10 });
    fireEvent.click(canvas, { detail: 1, clientX: 80, clientY: 80 });
    expect(screen.getByRole('button', { name: '完成折线' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '完成折线' }));
    await waitFor(() => expectObjectCount(1));

    fireEvent.click(canvas, { detail: 1, clientX: 20, clientY: 20 });
    fireEvent.click(canvas, { detail: 1, clientX: 70, clientY: 70 });
    fireEvent.click(screen.getByRole('button', { name: '完成折线' }));
    await waitFor(() => expectObjectCount(2));
    expect(screen.getByRole('button', { name: '折线' })).toHaveClass('active');
  });

  it('draws point annotations continuously with the reference setup', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });

    fireEvent.click(screen.getByRole('button', { name: '点' }));
    expect(screen.getByRole('dialog', { name: '绘制新点' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开始绘制点' }));
    fireEvent.click(canvas, { detail: 1, clientX: 25, clientY: 25 });
    fireEvent.click(screen.getByRole('button', { name: '完成点' }));
    await waitFor(() => expectObjectCount(1));

    fireEvent.click(canvas, { detail: 1, clientX: 75, clientY: 75 });
    fireEvent.click(screen.getByRole('button', { name: '完成点' }));
    await waitFor(() => expectObjectCount(2));
    expect(screen.getByRole('button', { name: '点' })).toHaveClass('active');
  });

  it('draws cuboids continuously and supports the reference four-point methods', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });

    fireEvent.click(screen.getByRole('button', { name: '立方体' }));
    expect(screen.getByRole('dialog', { name: '绘制新立方体' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '矩形' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '开始绘制立方体' }));
    fireEvent.click(canvas, { detail: 1, clientX: 10, clientY: 20 });
    fireEvent.click(canvas, { detail: 1, clientX: 60, clientY: 70 });
    await waitFor(() => expectObjectCount(1));
    expect(document.querySelector('.reference-shape polygon')).toBeTruthy();

    fireEvent.click(canvas, { detail: 1, clientX: 20, clientY: 30 });
    fireEvent.click(canvas, { detail: 1, clientX: 70, clientY: 80 });
    await waitFor(() => expectObjectCount(2));

    fireEvent.click(screen.getByRole('button', { name: '立方体' }));
    fireEvent.click(screen.getByRole('radio', { name: '四点' }));
    fireEvent.click(screen.getByRole('button', { name: '开始绘制立方体' }));
    fireEvent.click(canvas, { detail: 1, clientX: 15, clientY: 15 });
    fireEvent.click(canvas, { detail: 1, clientX: 55, clientY: 15 });
    fireEvent.click(canvas, { detail: 1, clientX: 55, clientY: 55 });
    fireEvent.click(canvas, { detail: 1, clientX: 15, clientY: 55 });
    await waitFor(() => expectObjectCount(3));
    expect(document.querySelectorAll('.reference-shape polygon')).toHaveLength(3);
  });

  it('draws a four-point rectangle from the reference method selector', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });

    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.click(screen.getByRole('radio', { name: '四点' }));
    fireEvent.click(screen.getByRole('button', { name: '开始绘制矩形' }));
    fireEvent.click(canvas, { detail: 1, clientX: 15, clientY: 15 });
    fireEvent.click(canvas, { detail: 1, clientX: 60, clientY: 15 });
    fireEvent.click(canvas, { detail: 1, clientX: 60, clientY: 60 });
    fireEvent.click(canvas, { detail: 1, clientX: 15, clientY: 60 });

    await waitFor(() => expectObjectCount(1));
    expect(document.querySelector('.reference-shape polygon')).toBeTruthy();
  });

  it('offers tracking for every supported drawing tool', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    for (const label of ['矩形', '多边形', '折线', '点', '立方体']) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('button', { name: `开始追踪${label}` })).toBeInTheDocument();
    }
  });

  it('creates a rectangle track across frames and preserves existing objects', async () => {
    mocks.loadAnnotationDocument.mockImplementation(async (datasetId: string, imageId: string): Promise<AnnotationDocument> => ({
      datasetId,
      imageId,
      revision: 0,
      annotations: imageId === 'image-2' ? [{ id: 'existing-box', label: 'scratch', color: '#52c41a', geometry: { type: 'rectangle', x: 60, y: 60, width: 20, height: 20 } }] : [],
      captions: [],
      imageAttributes: { includeInSdxl: false, tags: [] },
      updatedAt: '2026-07-27T00:00:00.000Z',
      updatedBy: 'tester',
      reviewStatus: 'draft',
    }));
    renderPage();
    await screen.findByText('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.click(screen.getByRole('button', { name: '开始追踪矩形' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '绘制新矩形' })).not.toBeInTheDocument());

    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });
    fireEvent.click(canvas, { detail: 1, clientX: 10, clientY: 10 });
    fireEvent.click(canvas, { detail: 1, clientX: 40, clientY: 40 });
    await waitFor(() => expectObjectCount(1));
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expectObjectCount(0);
    fireEvent.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() => expectObjectCount(1));

    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await screen.findByText('image-2.png');
    expectObjectCount(2);
    expect(document.querySelectorAll('.reference-object-heading')[1]).toHaveTextContent('追踪');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledWith(expect.objectContaining({ imageId: 'image-2', annotations: expect.arrayContaining([expect.objectContaining({ trackId: expect.stringMatching(/^track-/), keyframe: false, provenance: 'interpolated' }), expect.objectContaining({ id: 'existing-box' })]) })));
  });

  it('does not let an older save response erase a newer propagated track', async () => {
    const existing = (id: string, x: number) => ({ id, label: 'scratch', color: '#52c41a', geometry: { type: 'rectangle' as const, x, y: 60, width: 20, height: 20 } });
    mocks.loadAnnotationDocument.mockImplementation(async (datasetId: string, imageId: string): Promise<AnnotationDocument> => ({
      datasetId,
      imageId,
      revision: 0,
      annotations: imageId === 'image-1' ? [existing('existing-one', 60), existing('existing-two', 10)] : [existing('existing-three', 70)],
      captions: [],
      imageAttributes: { includeInSdxl: false, tags: [] },
      updatedAt: '2026-07-27T00:00:00.000Z',
      updatedBy: 'tester',
      reviewStatus: 'draft',
    }));
    const saveResolvers: Array<(document: AnnotationDocument) => void> = [];
    mocks.saveAnnotationDocument.mockImplementation((input: Pick<AnnotationDocument, 'datasetId' | 'imageId' | 'revision' | 'annotations' | 'captions' | 'imageAttributes'>) => new Promise<AnnotationDocument>((resolve) => {
      saveResolvers.push(() => resolve({ ...input, revision: input.revision + 1, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' }));
    }));
    renderPage();
    await screen.findByText('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.click(screen.getByRole('button', { name: '开始追踪矩形' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '绘制新矩形' })).not.toBeInTheDocument());

    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });
    fireEvent.click(canvas, { detail: 1, clientX: 10, clientY: 10 });
    fireEvent.click(canvas, { detail: 1, clientX: 40, clientY: 40 });
    await waitFor(() => expectObjectCount(3));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledTimes(1));

    fireEvent.click(canvas, { detail: 1, clientX: 45, clientY: 15 });
    fireEvent.click(canvas, { detail: 1, clientX: 75, clientY: 45 });
    await waitFor(() => expectObjectCount(4));
    saveResolvers.shift()?.(undefined as never);
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledTimes(2));
    saveResolvers.shift()?.(undefined as never);
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledTimes(3));
    saveResolvers.shift()?.(undefined as never);
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledTimes(4));
    saveResolvers.shift()?.(undefined as never);
    await waitFor(() => expect(mocks.saveAnnotationDocument.mock.calls.filter(([input]) => input.imageId === 'image-2').length).toBeGreaterThan(1));

    const latestImageTwoSave = mocks.saveAnnotationDocument.mock.calls.filter(([input]) => input.imageId === 'image-2').at(-1)?.[0];
    expect(latestImageTwoSave.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'existing-three' }),
      expect.objectContaining({ provenance: 'interpolated' }),
    ]));
    expect(new Set(latestImageTwoSave.annotations.map((annotation: AnnotationDocument['annotations'][number]) => annotation.trackId).filter(Boolean)).size).toBe(2);
  });

  it('does not let the initial frame load overwrite a track drawn during preload', async () => {
    const initialDocument: AnnotationDocument = { datasetId: 'dataset-1', imageId: 'image-1', revision: 0, annotations: [{ id: 'late-existing', label: 'scratch', color: '#52c41a', geometry: { type: 'rectangle', x: 60, y: 60, width: 20, height: 20 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' };
    let resolveInitial: ((document: AnnotationDocument) => void) | undefined;
    let imageOneCalls = 0;
    mocks.loadAnnotationDocument.mockImplementation(async (datasetId: string, imageId: string): Promise<AnnotationDocument> => {
      if (imageId === 'image-1' && imageOneCalls++ === 0) return new Promise((resolve) => { resolveInitial = resolve; });
      return { datasetId, imageId, revision: 0, annotations: [], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' };
    });
    renderPage();
    await screen.findByText('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.click(screen.getByRole('button', { name: '开始追踪矩形' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '绘制新矩形' })).not.toBeInTheDocument());
    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });
    fireEvent.click(canvas, { detail: 1, clientX: 10, clientY: 10 });
    fireEvent.click(canvas, { detail: 1, clientX: 40, clientY: 40 });
    await waitFor(() => expectObjectCount(1));
    resolveInitial?.(initialDocument);
    await waitFor(() => expect(document.querySelector('.reference-object-heading small')).toHaveTextContent('追踪'));
    expect(screen.queryByText('late-existing')).not.toBeInTheDocument();
  });

  it('copies an object across the task frames without replacing existing objects', async () => {
    mocks.loadAnnotationDocument.mockImplementation(async (datasetId: string, imageId: string): Promise<AnnotationDocument> => ({
      datasetId,
      imageId,
      revision: 0,
      annotations: imageId === 'image-1'
        ? [{ id: 'source-box', label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x: 10, y: 10, width: 20, height: 20 } }]
        : [{ id: 'existing-box', label: 'scratch', color: '#52c41a', geometry: { type: 'rectangle', x: 60, y: 60, width: 20, height: 20 } }],
      captions: [],
      imageAttributes: { includeInSdxl: false, tags: [] },
      updatedAt: '2026-07-27T00:00:00.000Z',
      updatedBy: 'tester',
      reviewStatus: 'draft',
    }));
    renderPage();
    await screen.findByText('image-1.png');
    fireEvent.click(document.querySelector('.reference-object')!);
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('标注已复制到任务段', '已保留其他帧的现有对象', 'success'));
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await screen.findByText('image-2.png');
    expectObjectCount(2);
  });

  it('keeps drawing clicks active when a new shape starts over an existing object', async () => {
    mocks.loadAnnotationDocument.mockResolvedValue({ datasetId: 'dataset-1', imageId: 'image-1', revision: 1, annotations: [{ id: 'existing-box', label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x: 10, y: 10, width: 50, height: 50 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' });
    renderPage();
    await screen.findByText('image-1.png');
    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });

    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.click(screen.getByRole('button', { name: '开始绘制矩形' }));
    fireEvent.click(document.querySelector('.reference-shape rect')!, { detail: 1, clientX: 20, clientY: 20 });
    fireEvent.click(canvas, { detail: 1, clientX: 80, clientY: 80 });

    await waitFor(() => expectObjectCount(2));
  });

  it('plays forward one frame when playback starts', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '播放/暂停' }));
    await screen.findByText('image-2.png', {}, { timeout: 1000 });
  });

  it('keeps the selected label when moving to the next frame', async () => {
    renderPage('/annotate/dataset-1?image=image-1&label=scratch');
    await screen.findByText('image-1.png');
    fireEvent.click(document.querySelector('.reference-panel-tabs button:nth-child(2)')!);
    expect(screen.getByRole('button', { name: 'scratch' })).toHaveClass('active');
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await screen.findByText('image-2.png');
    expect(screen.getByRole('button', { name: 'scratch' })).toHaveClass('active');
  });

  it('saves image tags and switches the reference workspace', async () => {
    renderPage();
    await screen.findByText('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '标签工具' }));
    fireEvent.change(screen.getByRole('textbox', { name: '图像标签' }), { target: { value: 'needs-review' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '图像标签' }), { key: 'Enter' });
    expect(screen.getByRole('button', { name: '移除标签 needs-review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledWith(expect.objectContaining({ imageAttributes: expect.objectContaining({ tags: ['needs-review'] }) })));

    const workspaceSelector = screen.getByRole('combobox', { name: '工作区' });
    expect(workspaceSelector).toHaveValue('standard');
    fireEvent.change(workspaceSelector, { target: { value: 'tags' } });
    expect(workspaceSelector).toHaveValue('tags');
  });

  it('does not render a second circular user menu inside the full-screen workbench', async () => {
    mocks.session.user.role = 'reviewer';
    renderPage();
    await screen.findByTestId('reference-workbench');
    expect(screen.queryByLabelText('用户菜单')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '退出登录' })).not.toBeInTheDocument();
  });

  it('draws a rectangle and saves it without losing the current draft', async () => {
    mocks.loadAnnotationDocument.mockResolvedValue({ datasetId: 'dataset-1', imageId: 'image-1', revision: 3, annotations: [{ id: 'box-1', label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x: 10, y: 10, width: 20, height: 20 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' });
    renderPage();
    await screen.findByText('image-1.png');
    expectObjectCount(1);
    fireEvent.keyDown(window, { key: 'Delete' });
    expectObjectCount(0);
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expectObjectCount(1);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalled());
    expect(mocks.saveAnnotationDocument.mock.calls.at(-1)?.[0].annotations[0].geometry.type).toBe('rectangle');
    expect(mocks.notify).toHaveBeenCalledWith('标注已保存', '当前任务段的未保存标注已全部保存', 'success');
  });

  it('saves all dirty frames in the current task segment', async () => {
    const job = { id: 'job-save-segment', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-save', sequence: 1, status: 'claimed' as const, assigneeId: 'tester', createdAt: '2026-07-27T00:00:00.000Z' };
    mocks.annotationJobs.mockResolvedValue([job]);
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-save', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-2', itemCount: 2 }]);
    renderPage();
    await screen.findByText('image-1.png');
    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });

    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.click(screen.getByRole('button', { name: '开始绘制矩形' }));
    fireEvent.click(canvas, { detail: 1, clientX: 10, clientY: 10 });
    fireEvent.click(canvas, { detail: 1, clientX: 40, clientY: 40 });
    await waitFor(() => expectObjectCount(1));
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await screen.findByText('image-2.png');

    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.click(screen.getByRole('button', { name: '开始绘制矩形' }));
    fireEvent.click(canvas, { detail: 1, clientX: 50, clientY: 50 });
    fireEvent.click(canvas, { detail: 1, clientX: 80, clientY: 80 });
    await waitFor(() => expectObjectCount(1));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledTimes(2));
    expect(new Set(mocks.saveAnnotationDocument.mock.calls.map(([input]) => input.imageId))).toEqual(new Set(['image-1', 'image-2']));
  });

  it('supports polygon and polyline finish with Enter and double click', async () => {
    mocks.loadAnnotationDocument.mockResolvedValue({ datasetId: 'dataset-1', imageId: 'image-1', revision: 1, annotations: [{ id: 'polygon-1', label: 'defect', color: '#1890ff', geometry: { type: 'polygon', points: [{ x: 10, y: 10 }, { x: 80, y: 10 }, { x: 50, y: 80 }] } }, { id: 'line-1', label: 'defect', color: '#52c41a', geometry: { type: 'polyline', points: [{ x: 20, y: 20 }, { x: 80, y: 80 }], strokeWidth: 1 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' });
    renderPage(); await screen.findByText('image-1.png');
    expectObjectCount(2);
  });

  it('matches the reference object row layout and updates an object label', async () => {
    mocks.loadAnnotationDocument.mockResolvedValue({ datasetId: 'dataset-1', imageId: 'image-1', revision: 1, annotations: [{ id: 'box-1', label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x: 10, y: 10, width: 20, height: 20 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' });
    renderPage(); await screen.findByText('image-1.png');
    const row = document.querySelector('.reference-object')!;
    expect(row.querySelector('.reference-object-heading small')).toHaveTextContent('矩形');
    const labelSelect = screen.getByRole('combobox', { name: '对象 1 标签' });
    expect(labelSelect).toHaveValue('defect');
    fireEvent.change(labelSelect, { target: { value: 'scratch' } });
    expect(labelSelect).toHaveValue('scratch');
  });

  it('matches reference object actions and exposes working object menu commands', async () => {
    mocks.loadAnnotationDocument.mockResolvedValue({ datasetId: 'dataset-1', imageId: 'image-1', revision: 1, annotations: [{ id: 'box-1', label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x: 10, y: 10, width: 20, height: 20 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' });
    renderPage(); await screen.findByText('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '锁定对象' }));
    expect(screen.getByRole('button', { name: '解锁对象' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '标记遮挡' }));
    expect(screen.getByRole('button', { name: '取消遮挡' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '隐藏对象' }));
    expect(screen.getByRole('button', { name: '显示对象' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '置顶对象' }));
    expect(screen.getByRole('button', { name: '取消置顶对象' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(document.querySelector('.reference-object-more')!);
    expect(screen.getByRole('menuitem', { name: '复制' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }));
    expect(mocks.notify).toHaveBeenCalledWith('对象已复制', '可使用 Ctrl+V 粘贴对象', 'success');
  });

  it('exposes reference keyboard shortcuts and object operations', async () => {
    renderPage(); await screen.findAllByRole('img', { name: '当前标注图像' });
    fireEvent.keyDown(window, { key: 'F1' });
    expect(screen.getByRole('dialog')).toHaveTextContent('Ctrl+S');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'F2' });
    expect(screen.getByRole('dialog')).toHaveTextContent('自动保存');
  });

  it('matches reference canvas rotation and grid shortcuts', async () => {
    renderPage(); await screen.findAllByRole('img', { name: '当前标注图像' });
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'F2' });
    expect(screen.getByRole('dialog')).toHaveTextContent('90°');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, altKey: true });
    expect(document.querySelector('.reference-canvas-area.grid')).toBeTruthy();
  });

  it('reviews a held job and updates its status', async () => {
    mocks.session.user.role = 'reviewer';
    const job = { id: 'review-job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'reviewing' as const, assigneeId: 'annotator-1', reviewerId: 'tester', createdAt: '2026-07-27T00:00:00.000Z' };
    mocks.annotationJobs.mockResolvedValue([job]); mocks.annotationSegments.mockResolvedValue([]); mocks.reviewAnnotationJob.mockResolvedValue({ ...job, status: 'approved' as const });
    renderPage('/annotate/dataset-1?image=image-1&mode=review&job=review-job-1');
    await screen.findByText('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    await waitFor(() => expect(mocks.reviewAnnotationJob).toHaveBeenCalledWith('review-job-1', { decision: 'approve' }));
    expect(await screen.findByTestId('datasets-page')).toBeInTheDocument();
    expect(mocks.notify).toHaveBeenCalledWith('暂无待审核任务', '当前数据集已没有可领取的待审核任务', 'info');
  });

  it('claims a submitted review job before enabling the review workbench', async () => {
    mocks.session.user.role = 'reviewer';
    const submittedJob = { id: 'review-job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'submitted' as const, assigneeId: 'annotator-1', createdAt: '2026-07-27T00:00:00.000Z' };
    const claimedJob = { ...submittedJob, status: 'reviewing' as const, reviewerId: 'tester' };
    mocks.annotationJobs.mockResolvedValue([submittedJob]);
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-2', itemCount: 2 }]);
    mocks.claimAnnotationReviewJob.mockResolvedValue(claimedJob);
    mocks.loadAnnotationDocument.mockResolvedValue({ datasetId: 'dataset-1', imageId: 'image-1', revision: 2, annotations: [{ id: 'annotator-box', label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x: 10, y: 10, width: 50, height: 40 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'annotator-1', reviewStatus: 'submitted' });

    renderPage('/annotate/dataset-1/job/review-job-1?image=image-1&mode=review');

    await screen.findByText('image-1.png');
    await waitFor(() => expect(mocks.claimAnnotationReviewJob).toHaveBeenCalledWith('review-job-1'));
    expectObjectCount(1);
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '通过' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '驳回' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '矩形' })).not.toBeDisabled();
  });

  it('saves reviewer edits and opens the next review job after approval', async () => {
    mocks.session.user.role = 'reviewer';
    const firstJob = { id: 'review-job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'reviewing' as const, assigneeId: 'annotator-1', reviewerId: 'tester', createdAt: '2026-07-27T00:00:00.000Z' };
    const nextJob = { id: 'review-job-2', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-2', sequence: 2, status: 'reviewing' as const, assigneeId: 'annotator-2', reviewerId: 'tester', createdAt: '2026-07-27T00:00:00.000Z' };
    let nextReady = false;
    mocks.annotationJobs.mockImplementation(async () => nextReady ? [nextJob] : [firstJob]);
    mocks.annotationSegments.mockResolvedValue([
      { id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-1', itemCount: 1 },
      { id: 'segment-2', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 2, startItemId: 'image-2', endItemId: 'image-2', itemCount: 1 },
    ]);
    mocks.reviewAnnotationJob.mockResolvedValue({ ...firstJob, status: 'approved' as const });
    mocks.claimNextAnnotationReviewJob.mockImplementation(async () => { nextReady = true; return nextJob; });
    mocks.loadAnnotationDocument.mockResolvedValue({ datasetId: 'dataset-1', imageId: 'image-1', revision: 1, annotations: [{ id: 'review-box', label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x: 10, y: 10, width: 30, height: 30 } }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'annotator-1', reviewStatus: 'submitted' });

    renderPage('/annotate/dataset-1/job/review-job-1?image=image-1&mode=review');
    await screen.findByText('image-1.png');
    await waitFor(() => expectObjectCount(1));
    fireEvent.click(screen.getByRole('button', { name: '标记为错' }));
    mocks.saveReviewedAnnotation.mockImplementation(async (_jobId: string, imageId: string, input: Pick<AnnotationDocument, 'revision' | 'annotations' | 'captions' | 'imageAttributes'>): Promise<AnnotationDocument> => ({ datasetId: 'dataset-1', imageId, ...input, revision: input.revision + 1, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'submitted' }));
    fireEvent.click(screen.getByRole('button', { name: '通过' }));

    await waitFor(() => expect(mocks.saveReviewedAnnotation).toHaveBeenCalledWith('review-job-1', 'image-1', expect.objectContaining({ annotations: expect.any(Array) })));
    await waitFor(() => expect(mocks.reviewAnnotationJob).toHaveBeenCalledWith('review-job-1', { decision: 'approve' }));
    await waitFor(() => expect(mocks.claimNextAnnotationReviewJob).toHaveBeenCalledWith('dataset-1'));
    expect(await screen.findByText('image-2.png')).toBeInTheDocument();
    expect(mocks.notify).toHaveBeenCalledWith('审核已通过', '已自动领取下一段待审核任务', 'success');
  });

  it('blocks submission before the last frame of the current segment', async () => {
    const job = { id: 'job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'claimed' as const, assigneeId: 'tester', createdAt: '2026-07-27T00:00:00.000Z' };
    mocks.annotationJobs.mockResolvedValue([job]);
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-2', itemCount: 2 }]);
    renderPage();
    await screen.findByText('image-1.png');
    const submitButton = screen.getByRole('button', { name: '提交' });
    expect(submitButton).not.toBeDisabled();
    fireEvent.click(submitButton);
    expect(mocks.submitAnnotationJob).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith('暂不能提交', '请先完成当前任务段的最后一帧', 'info');
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await screen.findByText('image-2.png');
    expect(screen.getByRole('button', { name: '提交' })).not.toBeDisabled();
  });

  it('allows submitting a segment with unannotated frames when on its last frame', async () => {
    const job = { id: 'job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'claimed' as const, assigneeId: 'tester', createdAt: '2026-07-27T00:00:00.000Z' };
    mocks.annotationJobs.mockResolvedValue([job]);
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-2', itemCount: 2 }]);
    mocks.submitAnnotationJob.mockResolvedValue({ ...job, status: 'submitted' as const });
    renderPage();
    await screen.findByText('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await screen.findByText('image-2.png');

    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledWith(expect.objectContaining({ imageId: 'image-2', annotations: [] })));
    await waitFor(() => expect(mocks.submitAnnotationJob).toHaveBeenCalledWith('job-1'));
    expect(mocks.notify).toHaveBeenCalledWith('暂无可标注任务', '当前任务段已提交，暂时没有可领取的下一段任务', 'info');
  });

  it('returns to the data center after submitting the last available job', async () => {
    const job = { id: 'job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'claimed' as const, assigneeId: 'tester', createdAt: '2026-07-27T00:00:00.000Z' };
    mocks.annotationJobs.mockResolvedValue([job]);
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-2', itemCount: 2 }]);
    mocks.submitAnnotationJob.mockResolvedValue({ ...job, status: 'submitted' as const });
    renderPage();
    await screen.findByText('image-1.png');
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await screen.findByText('image-2.png');

    const canvas = document.querySelector('.reference-canvas > svg')!;
    Object.defineProperty(canvas, 'getScreenCTM', { value: () => null });
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });
    fireEvent.click(screen.getByRole('button', { name: '矩形' }));
    fireEvent.click(screen.getByRole('button', { name: '开始绘制矩形' }));
    fireEvent.click(canvas, { detail: 1, clientX: 15, clientY: 15 });
    fireEvent.click(canvas, { detail: 1, clientX: 60, clientY: 60 });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(mocks.submitAnnotationJob).toHaveBeenCalledWith('job-1'));
    expect(await screen.findByTestId('datasets-page')).toBeInTheDocument();
    expect(mocks.notify).toHaveBeenCalledWith('暂无可标注任务', '当前任务段已提交，暂时没有可领取的下一段任务', 'info');
  });

  it('submits the current segment and automatically claims the next one', async () => {
    const firstJob = { id: 'job-first', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-first', sequence: 1, status: 'claimed' as const, assigneeId: 'tester', createdAt: '2026-07-27T00:00:00.000Z' };
    const nextJob = { id: 'job-next', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-next', sequence: 2, status: 'claimed' as const, assigneeId: 'tester', createdAt: '2026-07-27T00:00:00.000Z' };
    const firstSegment = { id: 'segment-first', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-1', itemCount: 1 };
    const nextSegment = { id: 'segment-next', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 2, startItemId: 'image-2', endItemId: 'image-2', itemCount: 1 };
    let advanced = false;
    mocks.annotationJobs.mockImplementation(async () => advanced ? [{ ...firstJob, status: 'submitted' as const }, nextJob] : [firstJob, { ...nextJob, status: 'available' as const, assigneeId: undefined }]);
    mocks.annotationSegments.mockImplementation(async () => advanced ? [nextSegment] : [firstSegment]);
    mocks.submitAnnotationJob.mockResolvedValue({ ...firstJob, status: 'submitted' as const });
    mocks.claimNextAnnotationJob.mockImplementation(async () => { advanced = true; return nextJob; });
    renderPage();
    await screen.findByText('image-1.png');

    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledWith(expect.objectContaining({ imageId: 'image-1' })));
    await waitFor(() => expect(mocks.submitAnnotationJob).toHaveBeenCalledWith('job-first'));
    await waitFor(() => expect(mocks.claimNextAnnotationJob).toHaveBeenCalledWith('dataset-1'));
    expect(await screen.findByText('image-2.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交' })).not.toBeDisabled();
  });

  it('claims an available job before loading an annotator workbench without an image', async () => {
    const availableJob = { id: 'job-available', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'available' as const, createdAt: '2026-07-27T00:00:00.000Z' };
    const claimedJob = { ...availableJob, status: 'claimed' as const, assigneeId: 'tester' };
    mocks.annotationJobs.mockResolvedValue([availableJob]);
    mocks.claimNextAnnotationJob.mockResolvedValue(claimedJob);
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-2', itemCount: 2 }]);
    renderPage('/annotate/dataset-1');

    expect(await screen.findByText('image-1.png')).toBeInTheDocument();
    expect(mocks.claimNextAnnotationJob).toHaveBeenCalledWith('dataset-1');
  });

  it('ends loading when an annotator has no available job or image', async () => {
    mocks.datasetImages.mockResolvedValue([]);
    renderPage('/annotate/dataset-1');

    expect(await screen.findByText('暂无可标注任务')).toBeInTheDocument();
    expect(screen.queryByText('正在加载标注任务…')).not.toBeInTheDocument();
  });

  it('keeps edits made while an autosave request is unresolved', async () => {
    const annotation = { id: 'box-1', label: 'defect', color: '#1890ff', geometry: { type: 'rectangle' as const, x: 10, y: 10, width: 20, height: 20 } };
    mocks.loadAnnotationDocument.mockResolvedValue({ datasetId: 'dataset-1', imageId: 'image-1', revision: 3, annotations: [annotation], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' });
    let resolveSave: ((document: AnnotationDocument) => void) | undefined;
    mocks.saveAnnotationDocument.mockImplementation(() => new Promise<AnnotationDocument>((resolve) => { resolveSave = resolve; }));
    renderPage();
    await screen.findByText('image-1.png');
    fireEvent.click(document.querySelector('.reference-object')!);
    await waitFor(() => expect(document.querySelector('.reference-object.selected')).toBeTruthy());
    expect(screen.getByRole('button', { name: '标记为错' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '标记为错' }));
    expectObjectCount(1);
    expect(screen.getByRole('button', { name: 'Issues 1' })).toHaveClass('active');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expectObjectCount(1);
    resolveSave?.({ datasetId: 'dataset-1', imageId: 'image-1', revision: 4, annotations: [{ ...annotation, flagged: true }], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' });
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledTimes(2));
    expect(mocks.saveAnnotationDocument.mock.calls[1][0].annotations).toHaveLength(1);
    expect(mocks.saveAnnotationDocument.mock.calls[1][0].annotations[0].flagged).toBeUndefined();
  });
});
