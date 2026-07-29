import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationDocument } from '../types';
import { AnnotationPage } from './AnnotationPage';

const mocks = vi.hoisted(() => ({
  loadAnnotationDocument: vi.fn(),
  saveAnnotationDocument: vi.fn(),
  loadAnnotationReview: vi.fn(),
  submitAnnotationReview: vi.fn(),
  decideAnnotationReview: vi.fn(),
  notify: vi.fn(),
}));

const images = [
  { id: 'image-1', datasetId: 'dataset-1', filename: 'image-1.png', mimeType: 'image/png', sizeBytes: 10, split: 'train' as const, createdAt: '2026-07-27T00:00:00.000Z' },
  { id: 'image-2', datasetId: 'dataset-1', filename: 'image-2.png', mimeType: 'image/png', sizeBytes: 10, split: 'train' as const, createdAt: '2026-07-27T00:00:00.000Z' },
];

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    datasets: [{ id: 'dataset-1', name: 'Test', description: '', version: 'v1', type: '目标检测', images: 2, annotated: 0, classes: ['defect'], updatedAt: '2026-07-27T00:00:00.000Z', size: '20 B', status: '标注中' }],
    datasetImages: vi.fn().mockResolvedValue(images),
    datasetImagePreview: vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo='),
    loadAnnotationDocument: mocks.loadAnnotationDocument,
    saveAnnotationDocument: mocks.saveAnnotationDocument,
    loadAnnotationReview: mocks.loadAnnotationReview,
    submitAnnotationReview: mocks.submitAnnotationReview,
    decideAnnotationReview: mocks.decideAnnotationReview,
    session: { accessToken: 'test-token', user: { id: 'tester', workspaceId: 'test', username: 'engineer', displayName: 'Engineer', role: 'engineer', mustChangePassword: false } },
    updateDatasetClasses: vi.fn(),
    notify: mocks.notify,
  }),
}));

function renderAnnotationPage() {
  return render(
    <MemoryRouter initialEntries={['/annotate/dataset-1?image=image-1']}>
      <Routes><Route path="/annotate/:datasetId" element={<AnnotationPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('AnnotationPage workspace', () => {
  beforeEach(() => {
    mocks.loadAnnotationDocument.mockReset().mockImplementation(async (datasetId: string, imageId: string): Promise<AnnotationDocument> => ({ datasetId, imageId, revision: 0, annotations: [], captions: [], imageAttributes: { includeInSdxl: false, tags: [] }, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' }));
    mocks.saveAnnotationDocument.mockReset().mockImplementation(async (input: Pick<AnnotationDocument, 'datasetId' | 'imageId' | 'revision' | 'annotations' | 'captions' | 'imageAttributes'>): Promise<AnnotationDocument> => ({ ...input, revision: input.revision + 1, updatedAt: '2026-07-27T00:00:00.000Z', updatedBy: 'tester', reviewStatus: 'draft' }));
    mocks.loadAnnotationReview.mockReset();
    mocks.submitAnnotationReview.mockReset().mockResolvedValue({ datasetId: 'dataset-1', datasetStatus: '待审核', total: 2, draft: 0, submitted: 2, approved: 0, rejected: 0, items: images.map((image) => ({ imageId: image.id, filename: image.filename, revision: 1, annotationCount: 1, reviewStatus: 'submitted' })) });
    mocks.decideAnnotationReview.mockReset();
    mocks.notify.mockReset();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  afterEach(cleanup);

  it('zooms with working buttons and enforces the supported range', async () => {
    renderAnnotationPage();
    await screen.findByText('所有更改已同步');

    fireEvent.click(screen.getByRole('button', { name: '放大画布' }));
    expect(screen.getByText('125%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '缩小画布' }));
    expect(screen.getByText('100%')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('画布缩放'), { target: { value: '25' } });
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '缩小画布' })).toBeDisabled();
  });

  it('zooms only with Ctrl or Command plus the mouse wheel', async () => {
    renderAnnotationPage();
    await screen.findByText('所有更改已同步');
    const scrollArea = screen.getByTestId('annotation-canvas-scroll');

    fireEvent.wheel(scrollArea, { deltaY: -100, clientX: 50, clientY: 50 });
    expect(screen.getByText('100%')).toBeInTheDocument();
    fireEvent.wheel(scrollArea, { ctrlKey: true, deltaY: -100, clientX: 50, clientY: 50 });
    expect(screen.getByText('125%')).toBeInTheDocument();
    fireEvent.wheel(scrollArea, { metaKey: true, deltaY: 100, clientX: 50, clientY: 50 });
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('centers the scroll position when fitting the image to the canvas', async () => {
    renderAnnotationPage();
    await screen.findByText('所有更改已同步');
    const scrollArea = screen.getByTestId('annotation-canvas-scroll');
    Object.defineProperties(scrollArea, {
      scrollWidth: { configurable: true, value: 1000 },
      clientWidth: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 700 },
      clientHeight: { configurable: true, value: 300 },
    });

    fireEvent.click(screen.getByRole('button', { name: '适应' }));

    await waitFor(() => expect(scrollArea.scrollLeft).toBe(300));
    expect(scrollArea.scrollTop).toBe(200);
  });

  it('supports tool and previous or next image shortcuts without hijacking form inputs', async () => {
    renderAnnotationPage();
    await screen.findByText('所有更改已同步');
    await waitFor(() => expect(screen.getAllByText('1 / 2')).toHaveLength(2));

    fireEvent.keyDown(window, { key: 'r' });
    expect(screen.getByRole('button', { name: '矩形框' })).toHaveClass('active');
    fireEvent.keyDown(window, { key: 'd' });
    await waitFor(() => expect(screen.getAllByText('2 / 2')).toHaveLength(2));
    await screen.findByText('所有更改已同步');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getAllByText('1 / 2')).toHaveLength(2));

    const zoomInput = screen.getByLabelText('画布缩放');
    zoomInput.focus();
    fireEvent.keyDown(zoomInput, { key: 'd' });
    expect(screen.getAllByText('1 / 2')).toHaveLength(2);
  });

  it('commits a rectangle from the final pointer position even when no move event is delivered', async () => {
    const { container } = renderAnnotationPage();
    await screen.findByText('所有更改已同步');
    const overlay = container.querySelector('.annotation-overlay') as SVGSVGElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));

    fireEvent.click(screen.getByRole('button', { name: '矩形框' }));
    fireEvent(overlay, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
    fireEvent(overlay, new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 60, clientY: 70 }));

    await screen.findByText('1 张图片待统一保存');
    expect(container.querySelectorAll('.rectangle-annotation')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledOnce());
    expect(mocks.saveAnnotationDocument.mock.calls[0][0].annotations[0].geometry).toEqual({ type: 'rectangle', x: 10, y: 20, width: 50, height: 50 });
  });

  it('uses the final pointer position when moving a rectangle without a move event', async () => {
    const { container } = renderAnnotationPage();
    await screen.findByText('所有更改已同步');
    const overlay = container.querySelector('.annotation-overlay') as SVGSVGElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));

    fireEvent.click(screen.getByRole('button', { name: '矩形框' }));
    fireEvent(overlay, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
    fireEvent(overlay, new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 60, clientY: 70 }));
    const rectangle = await waitFor(() => {
      const element = container.querySelector('.rectangle-annotation .annotation-shape');
      expect(element).not.toBeNull();
      return element as SVGRectElement;
    });

    fireEvent.click(screen.getByRole('button', { name: '选择' }));
    fireEvent(rectangle, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 30 }));
    fireEvent(overlay, new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 30, clientY: 40 }));

    await waitFor(() => expect(rectangle).toHaveAttribute('x', '20'));
    expect(rectangle).toHaveAttribute('y', '30');
    expect(rectangle).toHaveAttribute('width', '50');
    expect(rectangle).toHaveAttribute('height', '50');
  });

  it('keeps drafts while switching images and saves all changed images together', async () => {
    const { container } = renderAnnotationPage();
    await screen.findByText('所有更改已同步');
    await waitFor(() => expect(screen.getAllByText('1 / 2')).toHaveLength(2));
    const overlay = container.querySelector('.annotation-overlay') as SVGSVGElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));

    fireEvent.click(screen.getByRole('button', { name: '关键点' }));
    fireEvent.click(overlay, { clientX: 20, clientY: 20 });
    await screen.findByText('1 张图片待统一保存');

    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    await waitFor(() => expect(screen.getAllByText('2 / 2')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '关键点' }));
    fireEvent.click(overlay, { clientX: 30, clientY: 30 });
    await screen.findByText('2 张图片待统一保存');

    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledTimes(2));
    expect(mocks.saveAnnotationDocument.mock.calls.map(([input]) => input.imageId)).toEqual(['image-1', 'image-2']);
    expect(mocks.saveAnnotationDocument.mock.calls.map(([input]) => input.annotations[0]?.geometry)).toEqual([
      { type: 'keypoint', x: 20, y: 20, index: 1 },
      { type: 'keypoint', x: 30, y: 30, index: 1 },
    ]);
    await screen.findByText('所有更改已同步');

    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    await waitFor(() => expect(mocks.submitAnnotationReview).toHaveBeenCalledWith('dataset-1'));
    expect(await screen.findByText('待审核')).toBeInTheDocument();
  });

  it('discards only the current draft when resetting to the saved version', async () => {
    const { container } = renderAnnotationPage();
    await screen.findByText('所有更改已同步');
    const overlay = container.querySelector('.annotation-overlay') as SVGSVGElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));

    fireEvent.click(screen.getByRole('button', { name: '关键点' }));
    fireEvent.click(overlay, { clientX: 20, clientY: 20 });
    await screen.findByText('1 张图片待统一保存');
    fireEvent.click(screen.getByRole('button', { name: '重置到已保存版本' }));

    await screen.findByText('所有更改已同步');
    expect(mocks.loadAnnotationDocument).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('defect 01')).not.toBeInTheDocument();
  });

  it('creates a line and persists SDXL image-level annotations', async () => {
    const { container } = renderAnnotationPage();
    await screen.findByText('所有更改已同步');
    const overlay = container.querySelector('.annotation-overlay') as SVGSVGElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));

    fireEvent.click(screen.getByRole('button', { name: '线段' }));
    fireEvent.click(overlay, { clientX: 12, clientY: 18 });
    fireEvent.click(overlay, { clientX: 62, clientY: 68 });
    expect(container.querySelectorAll('.polyline-shape')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /SDXL/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: '纳入训练' }));
    fireEvent.change(screen.getByLabelText('SDXL 主 Caption'), { target: { value: 'a scratched metal surface under inspection light' } });
    fireEvent.change(screen.getByLabelText('SDXL 图像标签'), { target: { value: 'scratch, metal' } });
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));

    await waitFor(() => expect(mocks.saveAnnotationDocument).toHaveBeenCalledOnce());
    const saved = mocks.saveAnnotationDocument.mock.calls[0][0];
    expect(saved.annotations[0].geometry).toMatchObject({ type: 'polyline', points: [{ x: 12, y: 18 }, { x: 62, y: 68 }] });
    expect(saved.captions).toMatchObject([{ text: 'a scratched metal surface under inspection light', primary: true, language: 'en' }]);
    expect(saved.imageAttributes).toEqual({ includeInSdxl: true, tags: ['scratch', 'metal'] });
  });
});
