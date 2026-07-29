import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowLeft,
  BoxSelect,
  Check,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Circle,
  CloudUpload,
  Crosshair,
  Eye,
  EyeOff,
  Maximize2,
  Minus,
  MousePointer2,
  Lock,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  ShieldCheck,
  Shapes,
  Spline,
  Tag,
  Workflow,
  Trash2,
  Undo2,
  Unlock,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { EmptyState, PageHeader, ProgressBar } from '../components/ui';
import { useApp } from '../context/AppContext';
import { ApiClientError } from '../services/apiClient';
import type { AnnotationDocument, AnnotationImageAttributes, AnnotationRecord, AnnotationReviewStatus, AnnotationReviewSummary, DatasetImage, ImageCaption } from '../types';
import { ellipseFromPoints, moveEllipse, movePoints, moveRectangle, normalizeCanvasPoint, rectangleFromPoints, resizeRectangle, type RectangleHandle } from '../utils/annotation';

type AnnotationTool = 'select' | 'rect' | 'polygon' | 'line' | 'polyline' | 'ellipse' | 'keypoint' | 'skeleton';
interface Point { x: number; y: number }
interface AnnotationBase { id: string; label: string; color: string; locked?: boolean }
interface RectAnnotation extends AnnotationBase { type: 'rect'; x: number; y: number; width: number; height: number }
interface PolygonAnnotation extends AnnotationBase { type: 'polygon'; points: Point[] }
interface PolylineAnnotation extends AnnotationBase { type: 'polyline'; points: Point[]; strokeWidth: number }
interface EllipseAnnotation extends AnnotationBase { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotation: number }
interface KeypointAnnotation extends AnnotationBase { type: 'keypoint'; x: number; y: number; index: number }
interface SkeletonAnnotation extends AnnotationBase { type: 'skeleton'; points: Array<Point & { index: number; visibility: 0 | 1 | 2 }>; edges: Array<[number, number]> }
type Annotation = RectAnnotation | PolygonAnnotation | PolylineAnnotation | EllipseAnnotation | KeypointAnnotation | SkeletonAnnotation;
type AnnotationSyncState = 'loading' | 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error';
interface RectInteraction { annotationId: string; mode: 'move' | 'resize'; start: Point; original: RectAnnotation; handle?: RectangleHandle }
type PointerSession =
  | { pointerId: number; kind: 'draw-rect'; start: Point; draft: RectAnnotation }
  | { pointerId: number; kind: 'draw-ellipse'; start: Point; draft: EllipseAnnotation }
  | { pointerId: number; kind: 'edit-rect'; interaction: RectInteraction }
  | { pointerId: number; kind: 'move-shape'; start: Point; original: Annotation }
  | { pointerId: number; kind: 'edit-point'; annotationId: string; pointIndex: number; original: PolygonAnnotation | PolylineAnnotation | SkeletonAnnotation }
  | { pointerId: number; kind: 'resize-ellipse'; start: Point; original: EllipseAnnotation; axis: 'x' | 'y' };
interface AnnotationDraft { annotations: Annotation[]; captions: ImageCaption[]; imageAttributes: AnnotationImageAttributes; revision: number; dirty: boolean; reviewStatus: AnnotationReviewStatus; reviewComment?: string }
interface AnnotationConflict { imageId: string; document: AnnotationDocument }

const labelColors = ['#2383f2', '#ff9d2e', '#e25362', '#19b394', '#8b5cf6', '#0f9f9a'];
const minimumZoom = 0.25;
const maximumZoom = 4;
const zoomStep = 0.25;

const toolShortcuts: Record<AnnotationTool, string> = { select: 'V', rect: 'R', polygon: 'P', line: 'L', polyline: 'N', ellipse: 'E', keypoint: 'K', skeleton: 'S' };

const toolOptions: { id: AnnotationTool; label: string; icon: typeof MousePointer2 }[] = [
  { id: 'select', label: '选择', icon: MousePointer2 },
  { id: 'rect', label: '矩形框', icon: BoxSelect },
  { id: 'polygon', label: '多边形', icon: Shapes },
  { id: 'line', label: '线段', icon: Minus },
  { id: 'polyline', label: '折线', icon: Spline },
  { id: 'ellipse', label: '椭圆', icon: Circle },
  { id: 'keypoint', label: '关键点', icon: Crosshair },
  { id: 'skeleton', label: '骨架', icon: Workflow },
];

const rectangleHandles: RectangleHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function rectangleHandlePoint(annotation: RectAnnotation, handle: RectangleHandle): Point {
  const centerX = annotation.x + annotation.width / 2;
  const centerY = annotation.y + annotation.height / 2;
  return {
    x: handle.includes('w') ? annotation.x : handle.includes('e') ? annotation.x + annotation.width : centerX,
    y: handle.includes('n') ? annotation.y : handle.includes('s') ? annotation.y + annotation.height : centerY,
  };
}

function rectangleFromInteraction(interaction: RectInteraction, current: Point) {
  return interaction.mode === 'move'
    ? moveRectangle(interaction.original, { x: current.x - interaction.start.x, y: current.y - interaction.start.y })
    : resizeRectangle(interaction.original, interaction.handle ?? 'se', current);
}

function moveAnnotation(annotation: Annotation, delta: Point): Annotation {
  if (annotation.type === 'rect') return { ...annotation, ...moveRectangle(annotation, delta) };
  if (annotation.type === 'polygon') return { ...annotation, points: movePoints(annotation.points, delta) };
  if (annotation.type === 'polyline') return { ...annotation, points: movePoints(annotation.points, delta) };
  if (annotation.type === 'skeleton') return { ...annotation, points: annotation.points.map((point) => ({ ...point, x: Math.max(0, Math.min(100, point.x + delta.x)), y: Math.max(0, Math.min(100, point.y + delta.y)) })) };
  if (annotation.type === 'ellipse') return { ...annotation, ...moveEllipse(annotation, delta) };
  return { ...annotation, x: Math.max(0, Math.min(100, annotation.x + delta.x)), y: Math.max(0, Math.min(100, annotation.y + delta.y)) };
}

function updateAnnotationPoint(annotation: PolygonAnnotation | PolylineAnnotation | SkeletonAnnotation, index: number, point: Point): PolygonAnnotation | PolylineAnnotation | SkeletonAnnotation {
  if (annotation.type === 'skeleton') return { ...annotation, points: annotation.points.map((current, currentIndex) => currentIndex === index ? { ...current, ...point } : current) };
  return { ...annotation, points: annotation.points.map((current, currentIndex) => currentIndex === index ? point : current) };
}

function annotationIcon(type: Annotation['type']) {
  if (type === 'rect') return BoxSelect;
  if (type === 'polygon') return Shapes;
  if (type === 'polyline') return Spline;
  if (type === 'ellipse') return Circle;
  if (type === 'skeleton') return Workflow;
  return CircleDot;
}

function annotationTypeLabel(type: Annotation['type']) {
  return ({ rect: '矩形框', polygon: '多边形', polyline: '线段 / 折线', ellipse: '椭圆', keypoint: '关键点', skeleton: '骨架' } as const)[type];
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

function clampZoom(value: number) {
  return Math.min(maximumZoom, Math.max(minimumZoom, value));
}

function toCanvasAnnotation(record: AnnotationRecord): Annotation {
  const { geometry } = record;
  const base = { id: record.id, label: record.label, color: record.color, locked: record.locked };
  if (geometry.type === 'rectangle') return { ...base, type: 'rect', x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
  if (geometry.type === 'polygon') return { ...base, type: 'polygon', points: geometry.points };
  if (geometry.type === 'polyline') return { ...base, type: 'polyline', points: geometry.points, strokeWidth: geometry.strokeWidth };
  if (geometry.type === 'ellipse') return { ...base, type: 'ellipse', cx: geometry.cx, cy: geometry.cy, rx: geometry.rx, ry: geometry.ry, rotation: geometry.rotation };
  if (geometry.type === 'skeleton') return { ...base, type: 'skeleton', points: geometry.points, edges: geometry.edges };
  return { ...base, type: 'keypoint', x: geometry.x, y: geometry.y, index: geometry.index };
}

function toAnnotationRecord(annotation: Annotation): AnnotationRecord {
  const base = { id: annotation.id, label: annotation.label, color: annotation.color, locked: annotation.locked };
  if (annotation.type === 'rect') return { ...base, geometry: { type: 'rectangle', x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height } };
  if (annotation.type === 'polygon') return { ...base, geometry: { type: 'polygon', points: annotation.points } };
  if (annotation.type === 'polyline') return { ...base, geometry: { type: 'polyline', points: annotation.points, strokeWidth: annotation.strokeWidth } };
  if (annotation.type === 'ellipse') return { ...base, geometry: { type: 'ellipse', cx: annotation.cx, cy: annotation.cy, rx: annotation.rx, ry: annotation.ry, rotation: annotation.rotation } };
  if (annotation.type === 'skeleton') return { ...base, geometry: { type: 'skeleton', points: annotation.points, edges: annotation.edges } };
  return { ...base, geometry: { type: 'keypoint', x: annotation.x, y: annotation.y, index: annotation.index } };
}

export function AnnotationPage() {
  const { datasetId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const annotationImageId = searchParams.get('image') ?? '';
  const isReviewMode = searchParams.get('mode') === 'review';
  const { datasets, datasetImages, datasetImagePreview, decideAnnotationReview, loadAnnotationDocument, loadAnnotationReview, notify, saveAnnotationDocument, session, submitAnnotationReview, updateDatasetClasses } = useApp();
  const dataset = datasets.find((item) => item.id === datasetId);
  const activeDatasetId = dataset?.id ?? '';
  const labelOptions = useMemo(() => (dataset?.classes ?? []).map((name, index) => ({ name, color: labelColors[index % labelColors.length] })), [dataset]);
  const appRef = useRef<HTMLDivElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pointerSessionRef = useRef<PointerSession | null>(null);
  const annotationSequenceRef = useRef(0);
  const zoomRef = useRef(1);
  const savingRef = useRef(false);
  const draftsRef = useRef<Record<string, AnnotationDraft>>({});
  const conflictRef = useRef<AnnotationConflict | null>(null);
  const submitIntentRef = useRef(false);
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [revision, setRevision] = useState(0);
  const [syncState, setSyncState] = useState<AnnotationSyncState>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<{ name: string; color: string } | null>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [redoAnnotation, setRedoAnnotation] = useState<Annotation | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<'objects' | 'properties' | 'sdxl'>('objects');
  const [draftRect, setDraftRect] = useState<RectAnnotation | null>(null);
  const [draftEllipse, setDraftEllipse] = useState<EllipseAnnotation | null>(null);
  const [polygonPoints, setPolygonPoints] = useState<Point[]>([]);
  const [captions, setCaptions] = useState<ImageCaption[]>([]);
  const [imageAttributes, setImageAttributes] = useState<AnnotationImageAttributes>({ includeInSdxl: false, tags: [] });
  const [zoom, setZoom] = useState(1);
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  const [images, setImages] = useState<DatasetImage[]>([]);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [dirtyImageIds, setDirtyImageIds] = useState<string[]>([]);
  const [conflict, setConflict] = useState<AnnotationConflict | null>(null);
  const [reviewStatus, setReviewStatus] = useState<AnnotationReviewStatus>('draft');
  const [reviewComment, setReviewComment] = useState<string>();
  const [reviewSummary, setReviewSummary] = useState<AnnotationReviewSummary>();
  const [reviewBusy, setReviewBusy] = useState(false);
  const canReview = session?.user.role === 'admin' || session?.user.role === 'engineer';
  const editingLocked = isReviewMode || reviewStatus === 'submitted';

  useEffect(() => {
    if (!dataset) return;
    void datasetImages(dataset.id).then(setImages).catch((error: unknown) => notify('图像列表加载失败', error instanceof Error ? error.message : '无法读取数据集图像', 'error'));
  }, [dataset, datasetImages, notify]);

  useEffect(() => {
    if (!dataset || !isReviewMode) return;
    void loadAnnotationReview(dataset.id).then(setReviewSummary).catch((error: unknown) => notify('审核记录加载失败', error instanceof Error ? error.message : '无法读取审核记录', 'error'));
  }, [dataset, isReviewMode, loadAnnotationReview, notify]);

  useEffect(() => {
    if (!dataset || !annotationImageId) return;
    let active = true;
    let preview: string | null = null;
    setImageAspect(null);
    void datasetImagePreview(dataset.id, annotationImageId).then((url) => {
      preview = url;
      if (active) setImagePreview(url); else URL.revokeObjectURL(url);
    }).catch((error: unknown) => notify('图像预览加载失败', error instanceof Error ? error.message : '无法读取图像内容', 'error'));
    return () => { active = false; if (preview) URL.revokeObjectURL(preview); setImagePreview(null); };
  }, [annotationImageId, dataset, datasetImagePreview, notify]);

  const restoreSavedDocument = useCallback(async () => {
    if (!activeDatasetId || !annotationImageId) return;
    const draft = draftsRef.current[annotationImageId];
    if (draft) {
      setAnnotations(draft.annotations);
      setCaptions(draft.captions);
      setImageAttributes(draft.imageAttributes);
      setRevision(draft.revision);
      setReviewStatus(draft.reviewStatus);
      setReviewComment(draft.reviewComment);
      setSelectedId(draft.annotations[0]?.id ?? null);
      setPolygonPoints([]);
      setRedoAnnotation(null);
      setSyncState(conflictRef.current?.imageId === annotationImageId ? 'conflict' : draft.dirty ? 'unsaved' : 'saved');
      return;
    }
    setSyncState('loading');
    try {
      const document = await loadAnnotationDocument(activeDatasetId, annotationImageId);
      const restored = document.annotations.map(toCanvasAnnotation);
      draftsRef.current[annotationImageId] = { annotations: restored, captions: document.captions, imageAttributes: document.imageAttributes, revision: document.revision, dirty: false, reviewStatus: document.reviewStatus, reviewComment: document.reviewComment };
      setAnnotations(restored);
      setCaptions(document.captions);
      setImageAttributes(document.imageAttributes);
      setRevision(document.revision);
      setReviewStatus(document.reviewStatus);
      setReviewComment(document.reviewComment);
      setSelectedId(restored[0]?.id ?? null);
      setPolygonPoints([]);
      setRedoAnnotation(null);
      setSyncState('saved');
    } catch (error) {
      setSyncState('error');
      notify('标注加载失败', error instanceof Error ? error.message : '无法读取已保存的标注', 'error');
    }
  }, [activeDatasetId, annotationImageId, loadAnnotationDocument, notify]);

  useEffect(() => {
    void restoreSavedDocument();
  }, [restoreSavedDocument]);

  useEffect(() => {
    if (!annotationImageId || syncState !== 'unsaved') return;
    draftsRef.current[annotationImageId] = { annotations, captions, imageAttributes, revision, dirty: true, reviewStatus, reviewComment };
    setDirtyImageIds((current) => current.includes(annotationImageId) ? current : [...current, annotationImageId]);
  }, [annotationImageId, annotations, captions, imageAttributes, reviewComment, reviewStatus, revision, syncState]);

  useEffect(() => {
    if (!dirtyImageIds.length) return;
    const preventUnsavedExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnsavedExit);
    return () => window.removeEventListener('beforeunload', preventUnsavedExit);
  }, [dirtyImageIds.length]);

  const getPoint = (event: Pick<PointerEvent, 'clientX' | 'clientY'> | Pick<ReactPointerEvent<SVGElement>, 'clientX' | 'clientY'>): Point => {
    const rect = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
    return normalizeCanvasPoint(event.clientX, event.clientY, rect);
  };

  const selectedAnnotation = annotations.find((item) => item.id === selectedId);
  const selectionLabelPosition = selectedAnnotation ? selectedAnnotation.type === 'rect'
    ? { left: `${selectedAnnotation.x}%`, top: `${selectedAnnotation.y}%` }
    : selectedAnnotation.type === 'polygon' || selectedAnnotation.type === 'polyline' || selectedAnnotation.type === 'skeleton'
      ? { left: `${selectedAnnotation.points[0]?.x ?? 0}%`, top: `${selectedAnnotation.points[0]?.y ?? 0}%` }
      : selectedAnnotation.type === 'ellipse'
        ? { left: `${selectedAnnotation.cx - selectedAnnotation.rx}%`, top: `${selectedAnnotation.cy - selectedAnnotation.ry}%` }
        : { left: `${selectedAnnotation.x}%`, top: `${selectedAnnotation.y}%` } : undefined;
  const counts = useMemo(() => labelOptions.map((label) => ({ ...label, count: annotations.filter((item) => item.label === label.name).length })), [annotations, labelOptions]);
  const primaryCaption = captions.find((caption) => caption.primary) ?? captions[0];
  const hasImageAnnotation = annotations.length > 0 || captions.some((caption) => caption.text.trim()) || imageAttributes.tags.length > 0;

  useEffect(() => {
    setActiveLabel((current) => current && labelOptions.some((label) => label.name === current.name) ? current : labelOptions[0] ?? null);
  }, [labelOptions]);

  const requireActiveLabel = () => {
    if (activeLabel) return true;
    notify('请先添加标注类别', '右侧“类别”区域可添加类别，创建标注对象后才能保存', 'error');
    return false;
  };

  const createAnnotationId = (prefix: string) => `${prefix}-${Date.now()}-${annotationSequenceRef.current++}`;

  const capturePointer = (pointerId: number) => {
    const overlay = svgRef.current;
    if (!overlay || typeof overlay.setPointerCapture !== 'function') return;
    try { overlay.setPointerCapture(pointerId); } catch { /* The pointer may already have ended. */ }
  };

  const releasePointer = (pointerId: number) => {
    const overlay = svgRef.current;
    if (!overlay || typeof overlay.hasPointerCapture !== 'function' || typeof overlay.releasePointerCapture !== 'function') return;
    try { if (overlay.hasPointerCapture(pointerId)) overlay.releasePointerCapture(pointerId); } catch { /* Capture can be lost outside the window. */ }
  };

  const clearPointerSession = (pointerId?: number) => {
    const session = pointerSessionRef.current;
    pointerSessionRef.current = null;
    setDraftRect(null);
    setDraftEllipse(null);
    if (pointerId !== undefined) releasePointer(pointerId);
    else if (session) releasePointer(session.pointerId);
  };

  const beginRectInteraction = (event: ReactPointerEvent<SVGElement>, annotation: RectAnnotation, handle?: RectangleHandle) => {
    if (editingLocked || annotation.locked || tool !== 'select' || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(annotation.id);
    pointerSessionRef.current = {
      pointerId: event.pointerId,
      kind: 'edit-rect',
      interaction: { annotationId: annotation.id, mode: handle ? 'resize' : 'move', start: getPoint(event), original: annotation, handle },
    };
    capturePointer(event.pointerId);
  };

  const beginShapeMove = (event: ReactPointerEvent<SVGElement>, annotation: Annotation) => {
    if (editingLocked || annotation.locked || tool !== 'select' || event.button !== 0 || annotation.type === 'rect') return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(annotation.id);
    pointerSessionRef.current = { pointerId: event.pointerId, kind: 'move-shape', start: getPoint(event), original: structuredClone(annotation) };
    capturePointer(event.pointerId);
  };

  const beginPointEdit = (event: ReactPointerEvent<SVGElement>, annotation: PolygonAnnotation | PolylineAnnotation | SkeletonAnnotation, pointIndex: number) => {
    if (editingLocked || annotation.locked || tool !== 'select' || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(annotation.id);
    pointerSessionRef.current = { pointerId: event.pointerId, kind: 'edit-point', annotationId: annotation.id, pointIndex, original: structuredClone(annotation) };
    capturePointer(event.pointerId);
  };

  const beginEllipseResize = (event: ReactPointerEvent<SVGElement>, annotation: EllipseAnnotation, axis: 'x' | 'y') => {
    if (editingLocked || annotation.locked || tool !== 'select' || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(annotation.id);
    pointerSessionRef.current = { pointerId: event.pointerId, kind: 'resize-ellipse', start: getPoint(event), original: structuredClone(annotation), axis };
    capturePointer(event.pointerId);
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (editingLocked || event.button !== 0 || pointerSessionRef.current) return;
    if (tool === 'select') {
      setSelectedId(null);
      return;
    }
    if (!['rect', 'ellipse'].includes(tool) || !requireActiveLabel()) return;
    event.preventDefault();
    const start = getPoint(event);
    if (tool === 'ellipse') {
      const draft: EllipseAnnotation = { id: 'draft', type: 'ellipse', label: activeLabel?.name ?? '', color: activeLabel?.color ?? labelColors[0], ...ellipseFromPoints(start, start) };
      pointerSessionRef.current = { pointerId: event.pointerId, kind: 'draw-ellipse', start, draft };
      setDraftEllipse(draft);
      capturePointer(event.pointerId);
      return;
    }
    const draft: RectAnnotation = { id: 'draft', type: 'rect', label: activeLabel?.name ?? '', color: activeLabel?.color ?? labelColors[0], x: start.x, y: start.y, width: 0, height: 0 };
    pointerSessionRef.current = { pointerId: event.pointerId, kind: 'draw-rect', start, draft };
    setDraftRect(draft);
    capturePointer(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const current = getPoint(event);
    if (session.kind === 'edit-rect') {
      const { interaction } = session;
      const geometry = rectangleFromInteraction(interaction, current);
      setAnnotations((items) => items.map((item) => item.id === interaction.annotationId && item.type === 'rect' ? { ...item, ...geometry } : item));
      setSyncState('unsaved');
      return;
    }
    if (session.kind === 'move-shape') {
      const moved = moveAnnotation(session.original, { x: current.x - session.start.x, y: current.y - session.start.y });
      setAnnotations((items) => items.map((item) => item.id === moved.id ? moved : item));
      setSyncState('unsaved');
      return;
    }
    if (session.kind === 'edit-point') {
      const edited = updateAnnotationPoint(session.original, session.pointIndex, current);
      setAnnotations((items) => items.map((item) => item.id === session.annotationId ? edited : item));
      setSyncState('unsaved');
      return;
    }
    if (session.kind === 'resize-ellipse') {
      const resized = session.axis === 'x' ? { ...session.original, rx: Math.max(0.75, Math.min(session.original.cx, 100 - session.original.cx, Math.abs(current.x - session.original.cx))) } : { ...session.original, ry: Math.max(0.75, Math.min(session.original.cy, 100 - session.original.cy, Math.abs(current.y - session.original.cy))) };
      setAnnotations((items) => items.map((item) => item.id === resized.id ? resized : item));
      setSyncState('unsaved');
      return;
    }
    if (session.kind === 'draw-ellipse') {
      const draft = { ...session.draft, ...ellipseFromPoints(session.start, current) };
      session.draft = draft;
      setDraftEllipse(draft);
      return;
    }
    const draft = { ...session.draft, ...rectangleFromPoints(session.start, current) };
    session.draft = draft;
    setDraftRect(draft);
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (session.kind === 'draw-rect') {
      const finalDraft = { ...session.draft, ...rectangleFromPoints(session.start, getPoint(event)) };
      if (finalDraft.width >= 1.5 && finalDraft.height >= 1.5) {
        const annotation = { ...finalDraft, id: createAnnotationId('rect') };
        setAnnotations((current) => [...current, annotation]);
        setRedoAnnotation(null);
        setSelectedId(annotation.id);
        setSyncState('unsaved');
      }
    } else if (session.kind === 'draw-ellipse') {
      const finalDraft = { ...session.draft, ...ellipseFromPoints(session.start, getPoint(event)) };
      if (finalDraft.rx >= 0.75 && finalDraft.ry >= 0.75) {
        const annotation = { ...finalDraft, id: createAnnotationId('ellipse') };
        setAnnotations((current) => [...current, annotation]);
        setRedoAnnotation(null);
        setSelectedId(annotation.id);
        setSyncState('unsaved');
      }
    } else if (session.kind === 'edit-rect') {
      const { interaction } = session;
      const geometry = rectangleFromInteraction(interaction, getPoint(event));
      const changed = (['x', 'y', 'width', 'height'] as const).some((field) => Math.abs(geometry[field] - interaction.original[field]) > 0.001);
      if (changed) {
        setAnnotations((items) => items.map((item) => item.id === interaction.annotationId && item.type === 'rect' ? { ...item, ...geometry } : item));
        setSyncState('unsaved');
      }
    } else if (session.kind === 'move-shape') {
      const current = getPoint(event);
      const moved = moveAnnotation(session.original, { x: current.x - session.start.x, y: current.y - session.start.y });
      setAnnotations((items) => items.map((item) => item.id === moved.id ? moved : item));
      setSyncState('unsaved');
    } else if (session.kind === 'edit-point') {
      const edited = updateAnnotationPoint(session.original, session.pointIndex, getPoint(event));
      setAnnotations((items) => items.map((item) => item.id === session.annotationId ? edited : item));
      setSyncState('unsaved');
    }
    clearPointerSession(event.pointerId);
  };

  const cancelPointerInteraction = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (pointerSessionRef.current?.pointerId === event.pointerId) clearPointerSession(event.pointerId);
  };

  const handleCanvasClick = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (editingLocked) return;
    if (tool === 'polygon' || tool === 'line' || tool === 'polyline' || tool === 'skeleton') {
      if (!requireActiveLabel()) return;
      const point = getPoint(event);
      if (tool === 'line' && polygonPoints.length === 1) {
        const id = createAnnotationId('line');
        setAnnotations((current) => [...current, { id, type: 'polyline', label: activeLabel?.name ?? '', color: activeLabel?.color ?? labelColors[0], points: [polygonPoints[0], point], strokeWidth: 0.6 }]);
        setPolygonPoints([]);
        setSelectedId(id);
        setSyncState('unsaved');
      } else setPolygonPoints((current) => [...current, point]);
      return;
    }
    if (tool === 'keypoint') {
      if (!requireActiveLabel()) return;
      const point = getPoint(event);
      const id = createAnnotationId('key');
      setAnnotations((current) => [...current, { id, type: 'keypoint', label: activeLabel?.name ?? '', color: activeLabel?.color ?? labelColors[0], ...point, index: current.filter((item) => item.type === 'keypoint').length + 1 }]);
      setRedoAnnotation(null);
      setSelectedId(id);
      setSyncState('unsaved');
      return;
    }
  };

  const finishPolygon = () => {
    const minimumPoints = tool === 'polygon' ? 3 : tool === 'skeleton' ? 1 : 2;
    if (editingLocked || polygonPoints.length < minimumPoints || !['polygon', 'polyline', 'skeleton'].includes(tool)) return;
    const id = createAnnotationId(tool === 'skeleton' ? 'skeleton' : tool === 'polyline' ? 'path' : 'poly');
    const annotation: Annotation = tool === 'polygon'
      ? { id, type: 'polygon', label: activeLabel?.name ?? '', color: activeLabel?.color ?? labelColors[0], points: polygonPoints }
      : tool === 'polyline'
        ? { id, type: 'polyline', label: activeLabel?.name ?? '', color: activeLabel?.color ?? labelColors[0], points: polygonPoints, strokeWidth: 0.6 }
        : { id, type: 'skeleton', label: activeLabel?.name ?? '', color: activeLabel?.color ?? labelColors[0], points: polygonPoints.map((point, index) => ({ ...point, index: index + 1, visibility: 2 })), edges: polygonPoints.slice(1).map((_, index) => [index + 1, index + 2]) };
    setAnnotations((current) => [...current, annotation]);
    setRedoAnnotation(null);
    setPolygonPoints([]);
    setSelectedId(id);
    setSyncState('unsaved');
  };

  const deleteSelected = () => {
    if (editingLocked || !selectedId) return;
    const selected = annotations.find((item) => item.id === selectedId);
    if (selected) setRedoAnnotation(selected);
    setAnnotations((current) => current.filter((item) => item.id !== selectedId));
    setSelectedId(null);
    setSyncState('unsaved');
  };

  const undo = () => {
    if (editingLocked) return;
    if (polygonPoints.length) {
      setPolygonPoints((current) => current.slice(0, -1));
      return;
    }
    const last = annotations.at(-1);
    if (!last) return;
    setRedoAnnotation(last);
    setAnnotations((current) => current.slice(0, -1));
    setSelectedId(null);
    setSyncState('unsaved');
  };

  const redo = () => {
    if (editingLocked || !redoAnnotation) return;
    setAnnotations((current) => [...current, redoAnnotation]);
    setSelectedId(redoAnnotation.id);
    setRedoAnnotation(null);
    setSyncState('unsaved');
  };

  const clearConflict = () => {
    conflictRef.current = null;
    setConflict(null);
  };

  const applyServerDocument = (document: AnnotationDocument) => {
    const restored = document.annotations.map(toCanvasAnnotation);
    draftsRef.current[document.imageId] = { annotations: restored, captions: document.captions, imageAttributes: document.imageAttributes, revision: document.revision, dirty: false, reviewStatus: document.reviewStatus, reviewComment: document.reviewComment };
    setDirtyImageIds((current) => current.filter((imageId) => imageId !== document.imageId));
    setAnnotations(restored);
    setCaptions(document.captions);
    setImageAttributes(document.imageAttributes);
    setRevision(document.revision);
    setReviewStatus(document.reviewStatus);
    setReviewComment(document.reviewComment);
    setSelectedId(restored[0]?.id ?? null);
    clearConflict();
    setSyncState('saved');
  };

  const saveAllDocuments = async (submitForReview = false, revisionOverrides: Record<string, number> = {}) => {
    if (!dataset || !annotationImageId || savingRef.current || editingLocked) return;
    const pendingDrafts = { ...draftsRef.current };
    if (syncState === 'unsaved' || syncState === 'conflict') pendingDrafts[annotationImageId] = { annotations, captions, imageAttributes, revision, dirty: true, reviewStatus, reviewComment };
    const dirtyDrafts = Object.entries(pendingDrafts).filter(([, draft]) => draft.dirty);
    if (!dirtyDrafts.length && !submitForReview) {
      notify('所有标注已保存', '当前没有未保存的图片草稿', 'info');
      return;
    }
    const invalidDraft = dirtyDrafts.find(([, draft]) => draft.annotations.some((annotation) => !annotation.label.trim()));
    if (invalidDraft) {
      const imageName = images.find((image) => image.id === invalidDraft[0])?.filename ?? invalidDraft[0];
      notify('标注未保存', `${imageName} 存在未设置类别的标注对象`, 'error');
      return;
    }
    const invalidCaption = dirtyDrafts.find(([, draft]) => draft.imageAttributes.includeInSdxl && !draft.captions.some((caption) => caption.primary && caption.text.trim()));
    if (invalidCaption) {
      const imageName = images.find((image) => image.id === invalidCaption[0])?.filename ?? invalidCaption[0];
      notify('SDXL 标注未保存', `${imageName} 已纳入 SDXL，但没有填写主 Caption`, 'error');
      return;
    }
    savingRef.current = true;
    submitIntentRef.current = submitForReview;
    setSyncState('saving');
    let savedCount = 0;
    try {
      for (const [imageId, draft] of dirtyDrafts) {
        try {
          const document = await saveAnnotationDocument({
            datasetId: dataset.id,
            imageId,
            revision: revisionOverrides[imageId] ?? draft.revision,
            annotations: draft.annotations.map(toAnnotationRecord),
            captions: draft.captions,
            imageAttributes: draft.imageAttributes,
          });
          const restored = document.annotations.map(toCanvasAnnotation);
          draftsRef.current[imageId] = { annotations: restored, captions: document.captions, imageAttributes: document.imageAttributes, revision: document.revision, dirty: false, reviewStatus: document.reviewStatus, reviewComment: document.reviewComment };
          setDirtyImageIds((current) => current.filter((dirtyId) => dirtyId !== imageId));
          if (imageId === annotationImageId) {
            setAnnotations(restored);
            setCaptions(document.captions);
            setImageAttributes(document.imageAttributes);
            setRevision(document.revision);
            setReviewStatus(document.reviewStatus);
            setReviewComment(document.reviewComment);
          }
          savedCount += 1;
        } catch (error) {
          if (!(error instanceof ApiClientError) || error.code !== 'ANNOTATION_REVISION_CONFLICT') throw error;
          const latest = await loadAnnotationDocument(dataset.id, imageId);
          const nextConflict = { imageId, document: latest };
          conflictRef.current = nextConflict;
          setConflict(nextConflict);
          if (imageId !== annotationImageId) setSearchParams(isReviewMode ? { image: imageId, mode: 'review' } : { image: imageId });
          setSyncState('conflict');
          const imageName = images.find((image) => image.id === imageId)?.filename ?? imageId;
          notify('检测到标注版本冲突', `${imageName} 的当前绘制已保留，请选择加载服务器版本或覆盖保存`, 'error');
          return;
        }
      }
      let reviewSummary: AnnotationReviewSummary | undefined;
      if (submitForReview) {
        reviewSummary = await submitAnnotationReview(dataset.id);
        setReviewSummary(reviewSummary);
        for (const item of reviewSummary.items) {
          const draft = draftsRef.current[item.imageId];
          if (draft) draftsRef.current[item.imageId] = { ...draft, reviewStatus: item.reviewStatus, reviewComment: item.reviewComment };
        }
        const currentReview = reviewSummary.items.find((item) => item.imageId === annotationImageId);
        if (currentReview) {
          setReviewStatus(currentReview.reviewStatus);
          setReviewComment(currentReview.reviewComment);
        }
      }
      clearConflict();
      submitIntentRef.current = false;
      setSyncState('saved');
      notify(submitForReview ? '标注已提交审核' : '标注已全部保存', submitForReview ? `共 ${reviewSummary?.submitted ?? 0} 张图片等待审核` : `已同步 ${savedCount} 张图片的标注`);
    } catch (error) {
      submitIntentRef.current = false;
      setSyncState('error');
      notify('标注未保存', error instanceof Error ? `已保存 ${savedCount} 张图片，随后失败：${error.message}` : '服务暂时不可用，请稍后重试', 'error');
    } finally {
      savingRef.current = false;
    }
  };

  const keepCurrentAndOverwrite = () => {
    if (!conflict || conflict.imageId !== annotationImageId) return;
    const submitAfterConflict = submitIntentRef.current;
    const latestRevision = conflict.document.revision;
    clearConflict();
    void saveAllDocuments(submitAfterConflict, { [annotationImageId]: latestRevision });
  };

  const loadServerVersion = () => {
    if (!conflict || conflict.imageId !== annotationImageId) return;
    submitIntentRef.current = false;
    applyServerDocument(conflict.document);
    notify('已加载服务器版本', `当前图像已恢复到 revision ${conflict.document.revision}`, 'info');
  };

  const applyReviewSummary = (summary: AnnotationReviewSummary) => {
    setReviewSummary(summary);
    for (const item of summary.items) {
      const draft = draftsRef.current[item.imageId];
      if (draft) draftsRef.current[item.imageId] = { ...draft, reviewStatus: item.reviewStatus, reviewComment: item.reviewComment };
    }
    const current = summary.items.find((item) => item.imageId === annotationImageId);
    if (current) {
      setReviewStatus(current.reviewStatus);
      setReviewComment(current.reviewComment);
    }
  };

  const reviewAnnotations = async (decision: 'approve' | 'reject', scope: 'current' | 'all') => {
    if (!dataset || !canReview || reviewBusy) return;
    let comment: string | undefined;
    if (decision === 'reject') {
      const reason = window.prompt(scope === 'all' ? '填写批量驳回原因' : '填写驳回原因');
      if (!reason?.trim()) return;
      comment = reason.trim();
    }
    setReviewBusy(true);
    try {
      const before = await loadAnnotationReview(dataset.id);
      const imageIds = scope === 'all'
        ? before.items.filter((item) => item.reviewStatus === 'submitted').map((item) => item.imageId)
        : reviewStatus === 'submitted' ? [annotationImageId] : [];
      if (!imageIds.length) {
        notify('没有待审核标注', '当前范围内没有可处理的图片', 'info');
        return;
      }
      const summary = await decideAnnotationReview(dataset.id, { imageIds, decision, comment });
      applyReviewSummary(summary);
      const next = summary.items.find((item) => item.reviewStatus === 'submitted');
      if (scope === 'current' && next && next.imageId !== annotationImageId) setSearchParams({ image: next.imageId, mode: 'review' });
      notify(decision === 'approve' ? '审核已通过' : '标注已驳回', scope === 'all' ? `已处理 ${imageIds.length} 张图片` : images.find((image) => image.id === annotationImageId)?.filename ?? annotationImageId);
    } catch (error) {
      notify('审核操作失败', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error');
    } finally {
      setReviewBusy(false);
    }
  };

  const resetCurrentImage = () => {
    if (!annotationImageId) return;
    delete draftsRef.current[annotationImageId];
    setDirtyImageIds((current) => current.filter((imageId) => imageId !== annotationImageId));
    if (conflict?.imageId === annotationImageId) clearConflict();
    void restoreSavedDocument();
  };

  const toggleVisibility = (id: string) => setHiddenIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const toggleAnnotationLock = (id: string) => {
    if (editingLocked) return;
    setAnnotations((current) => current.map((annotation) => annotation.id === id ? { ...annotation, locked: !annotation.locked } : annotation));
    setSyncState('unsaved');
  };

  const updatePrimaryCaption = (text: string, language: ImageCaption['language'] = primaryCaption?.language ?? 'en') => {
    if (editingLocked) return;
    const nextCaption: ImageCaption = {
      id: primaryCaption?.id ?? `caption-${annotationImageId}`,
      text,
      language,
      primary: true,
      source: 'human',
    };
    setCaptions(text.length ? [nextCaption, ...captions.filter((caption) => caption.id !== primaryCaption?.id && !caption.primary)] : []);
    setSyncState('unsaved');
  };

  const updateImageAttributes = (next: Partial<AnnotationImageAttributes>) => {
    if (editingLocked) return;
    setImageAttributes((current) => ({ ...current, ...next }));
    setSyncState('unsaved');
  };

  const updateCropField = (field: 'x' | 'y' | 'width' | 'height', value: number) => {
    if (!Number.isFinite(value)) return;
    const crop = imageAttributes.crop ?? { x: 0, y: 0, width: 100, height: 100 };
    const bounded = Math.max(0, Math.min(100, value));
    const next = { ...crop, [field]: bounded };
    next.width = Math.max(1, Math.min(next.width, 100 - next.x));
    next.height = Math.max(1, Math.min(next.height, 100 - next.y));
    updateImageAttributes({ crop: next });
  };

  const updateSelectedRectangle = (field: 'x' | 'y' | 'width' | 'height', value: number) => {
    if (editingLocked || !selectedAnnotation || selectedAnnotation.type !== 'rect' || !Number.isFinite(value)) return;
    const next = { ...selectedAnnotation, [field]: value };
    const normalized = field === 'x' || field === 'y'
      ? moveRectangle(next, { x: 0, y: 0 })
      : resizeRectangle(selectedAnnotation, field === 'width' ? 'e' : 's', {
          x: field === 'width' ? selectedAnnotation.x + value : selectedAnnotation.x + selectedAnnotation.width,
          y: field === 'height' ? selectedAnnotation.y + value : selectedAnnotation.y + selectedAnnotation.height,
        });
    setAnnotations((items) => items.map((item) => item.id === selectedAnnotation.id && item.type === 'rect' ? { ...item, ...normalized } : item));
    setSyncState('unsaved');
  };

  const addClass = async () => {
    if (!dataset || editingLocked) return;
    const name = window.prompt('输入新类别名称');
    if (!name?.trim()) return;
    try {
      const nextName = name.trim();
      if (dataset.classes.includes(nextName)) {
        notify('类别未添加', '该类别已存在', 'info');
        return;
      }
      await updateDatasetClasses(dataset.id, [...dataset.classes, nextName]);
      setAnnotations((items) => items.map((item) => item.label ? item : { ...item, label: nextName, color: labelColors[dataset.classes.length % labelColors.length] }));
      if (annotations.some((item) => !item.label)) setSyncState('unsaved');
      notify('类别已添加', `${name.trim()} 已加入数据集类别`);
    } catch (error) {
      notify('类别未添加', error instanceof Error ? error.message : '服务暂时不可用，请稍后重试', 'error');
    }
  };

  const currentImageIndex = images.findIndex((image) => image.id === annotationImageId);
  const dirtyCount = dirtyImageIds.length + (syncState === 'unsaved' && !dirtyImageIds.includes(annotationImageId) ? 1 : 0);
  const confirmWorkspaceExit = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (dirtyCount > 0 && !window.confirm(`还有 ${dirtyCount} 张图片的标注未保存，确定离开吗？`)) event.preventDefault();
  };

  const navigateToImage = (targetIndex: number) => {
    const target = images[targetIndex];
    if (!target || target.id === annotationImageId) return;
    if (syncState === 'saving' || syncState === 'loading') return;
    if (conflict) {
      notify('请先处理版本冲突', '加载服务器版本或保留当前标注后才能切换图片', 'error');
      return;
    }
    if (polygonPoints.length) {
      notify('请先完成当前对象', '完成或撤销当前多点对象后再切换图片', 'error');
      return;
    }
    if (syncState === 'unsaved') {
      draftsRef.current[annotationImageId] = { annotations, captions, imageAttributes, revision, dirty: true, reviewStatus, reviewComment };
      setDirtyImageIds((current) => current.includes(annotationImageId) ? current : [...current, annotationImageId]);
    }
    clearPointerSession();
    setSyncState('loading');
    setSelectedId(null);
    setSearchParams(isReviewMode ? { image: target.id, mode: 'review' } : { image: target.id });
  };

  const activateTool = (nextTool: AnnotationTool) => {
    if (editingLocked && nextTool !== 'select') return;
    clearPointerSession();
    setTool(nextTool);
    if (!['polygon', 'line', 'polyline', 'skeleton'].includes(nextTool)) setPolygonPoints([]);
  };

  const updateZoom = (value: number) => {
    const nextZoom = clampZoom(value);
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
  };
  const adjustZoom = (delta: number) => updateZoom(zoomRef.current + delta);
  const centerCanvas = useCallback(() => {
    const scrollArea = canvasScrollRef.current;
    if (!scrollArea) return;
    scrollArea.scrollLeft = Math.max(0, (scrollArea.scrollWidth - scrollArea.clientWidth) / 2);
    scrollArea.scrollTop = Math.max(0, (scrollArea.scrollHeight - scrollArea.clientHeight) / 2);
  }, []);
  const fitCanvas = () => {
    updateZoom(1);
    window.requestAnimationFrame(centerCanvas);
  };

  useEffect(() => {
    if (!imageAspect) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(centerCanvas);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [annotationImageId, centerCanvas, imageAspect]);

  useEffect(() => {
    const scrollArea = canvasScrollRef.current;
    if (!scrollArea) return;
    let frame = 0;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const previousZoom = zoomRef.current;
      const nextZoom = clampZoom(previousZoom + (event.deltaY > 0 ? -zoomStep : zoomStep));
      if (nextZoom === previousZoom) return;
      const bounds = scrollArea.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;
      const contentX = scrollArea.scrollLeft + pointerX;
      const contentY = scrollArea.scrollTop + pointerY;
      updateZoom(nextZoom);
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const scale = nextZoom / previousZoom;
        scrollArea.scrollLeft = contentX * scale - pointerX;
        scrollArea.scrollTop = contentY * scale - pointerY;
      });
    };
    scrollArea.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.cancelAnimationFrame(frame);
      scrollArea.removeEventListener('wheel', handleWheel);
    };
  }, [activeDatasetId, annotationImageId]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const commandKey = event.ctrlKey || event.metaKey;

      if (commandKey && key === 's') {
        event.preventDefault();
        if (!editingLocked) void saveAllDocuments();
        return;
      }
      if (commandKey && key === 'z') {
        event.preventDefault();
        if (!editingLocked) { if (event.shiftKey) redo(); else undo(); }
        return;
      }
      if (commandKey && key === 'y') {
        event.preventDefault();
        if (!editingLocked) redo();
        return;
      }
      if (commandKey || event.altKey || event.repeat) return;

      const shortcutTool = ({ v: 'select', r: 'rect', p: 'polygon', l: 'line', n: 'polyline', e: 'ellipse', k: 'keypoint', s: 'skeleton', '1': 'select', '2': 'rect', '3': 'polygon', '4': 'line', '5': 'polyline', '6': 'ellipse', '7': 'keypoint', '8': 'skeleton' } as Record<string, AnnotationTool>)[key];
      if (shortcutTool) {
        event.preventDefault();
        if (!editingLocked || shortcutTool === 'select') activateTool(shortcutTool);
        return;
      }
      if (key === 'arrowleft' || key === 'a') {
        event.preventDefault();
        navigateToImage(currentImageIndex - 1);
        return;
      }
      if (key === 'arrowright' || key === 'd') {
        event.preventDefault();
        navigateToImage(currentImageIndex + 1);
        return;
      }
      if (key === 'home') {
        event.preventDefault();
        navigateToImage(0);
        return;
      }
      if (key === 'end') {
        event.preventDefault();
        navigateToImage(images.length - 1);
        return;
      }
      const pathMinimum = tool === 'polygon' ? 3 : tool === 'skeleton' ? 1 : 2;
      if (key === 'enter' && polygonPoints.length >= pathMinimum && ['polygon', 'polyline', 'skeleton'].includes(tool)) {
        event.preventDefault();
        if (!editingLocked) finishPolygon();
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        event.preventDefault();
        if (!editingLocked) deleteSelected();
        return;
      }
      if (key === 'escape') {
        event.preventDefault();
        clearPointerSession();
        setPolygonPoints([]);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await appRef.current?.requestFullscreen();
  };

  if (!dataset || !annotationImageId) {
    return <div className="page"><PageHeader eyebrow="数据中心 / 标注工作台" title="请选择数据集图像" description="标注工作台需要一个真实的数据集图像。" actions={<Link className="button secondary" to="/datasets"><ArrowLeft size={16} />返回数据中心</Link>} /><section className="panel"><EmptyState icon={CloudUpload} title="暂无可标注图像" description="请从已创建的数据集进入，并通过 image 参数指定图像 ID。" /></section></div>;
  }

  return (
    <div className="annotation-app" ref={appRef}>
      <header className="annotation-header">
        <div className="annotation-primary-actions">
          <Link className="annotation-command" to="/datasets" aria-label="返回数据中心" title="返回数据中心" onClick={confirmWorkspaceExit}><ArrowLeft size={19} /><span>返回</span></Link>
          {!isReviewMode && <>
            <button className="annotation-command" title="保存全部标注 (Ctrl/Command + S)" aria-keyshortcuts="Control+S Meta+S" onClick={() => void saveAllDocuments()} disabled={editingLocked || syncState === 'loading' || syncState === 'saving' || syncState === 'conflict'}><Save size={19} /><span>保存全部</span></button>
            <button className="annotation-command" title="撤销 (Ctrl/Command + Z)" aria-keyshortcuts="Control+Z Meta+Z" onClick={undo} disabled={editingLocked || (!annotations.length && !polygonPoints.length)}><Undo2 size={19} /><span>撤销</span></button>
            <button className="annotation-command" title="重做 (Ctrl/Command + Shift + Z)" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" onClick={redo} disabled={editingLocked || !redoAnnotation}><Redo2 size={19} /><span>重做</span></button>
            <button className="annotation-command" title="保存全部并提交审核" onClick={() => void saveAllDocuments(true)} disabled={editingLocked || syncState === 'loading' || syncState === 'saving' || syncState === 'conflict'}><Check size={19} /><span>提交审核</span></button>
          </>}
          {isReviewMode && <>
            <button className="annotation-command" title="通过当前图片" onClick={() => void reviewAnnotations('approve', 'current')} disabled={!canReview || reviewBusy || reviewStatus !== 'submitted'}><ShieldCheck size={19} /><span>通过当前</span></button>
            <button className="annotation-command" title="驳回当前图片" onClick={() => void reviewAnnotations('reject', 'current')} disabled={!canReview || reviewBusy || reviewStatus !== 'submitted'}><XCircle size={19} /><span>驳回当前</span></button>
            <button className="annotation-command compact" title="通过全部待审核图片" onClick={() => void reviewAnnotations('approve', 'all')} disabled={!canReview || reviewBusy || !reviewSummary?.submitted}><ShieldCheck size={18} /><span>全部通过</span></button>
            <button className="annotation-command compact" title="驳回全部待审核图片" onClick={() => void reviewAnnotations('reject', 'all')} disabled={!canReview || reviewBusy || !reviewSummary?.submitted}><XCircle size={18} /><span>全部驳回</span></button>
          </>}
        </div>

        <div className="annotation-image-navigation">
          <button className="icon-button" onClick={() => navigateToImage(0)} disabled={currentImageIndex <= 0} aria-label="第一张" aria-keyshortcuts="Home" title="第一张 (Home)"><ChevronFirst size={22} /></button>
          <button className="icon-button" onClick={() => navigateToImage(currentImageIndex - 1)} disabled={currentImageIndex <= 0} aria-label="上一张" aria-keyshortcuts="ArrowLeft A" title="上一张 (A / 左方向键)"><ChevronLeft size={23} /></button>
          <div className="annotation-image-title"><strong>{images[currentImageIndex]?.filename ?? annotationImageId}</strong><span>{currentImageIndex >= 0 ? currentImageIndex + 1 : 0} / {images.length}</span></div>
          <button className="icon-button" onClick={() => navigateToImage(currentImageIndex + 1)} disabled={currentImageIndex < 0 || currentImageIndex >= images.length - 1} aria-label="下一张" aria-keyshortcuts="ArrowRight D" title="下一张 (D / 右方向键)"><ChevronRight size={23} /></button>
          <button className="icon-button" onClick={() => navigateToImage(images.length - 1)} disabled={currentImageIndex < 0 || currentImageIndex >= images.length - 1} aria-label="最后一张" aria-keyshortcuts="End" title="最后一张 (End)"><ChevronLast size={22} /></button>
        </div>

        <div className="annotation-view-actions">
          <div className="annotation-zoom-control">
            <button type="button" aria-label="缩小画布" title="缩小画布" onClick={() => adjustZoom(-zoomStep)} disabled={zoom <= minimumZoom}><ZoomOut size={16} /></button>
            <input aria-label="画布缩放" type="range" min="25" max="400" step="5" value={Math.round(zoom * 100)} onChange={(event) => updateZoom(Number(event.target.value) / 100)} />
            <button type="button" aria-label="放大画布" title="放大画布" onClick={() => adjustZoom(zoomStep)} disabled={zoom >= maximumZoom}><ZoomIn size={16} /></button>
            <output>{Math.round(zoom * 100)}%</output>
          </div>
          <button className="annotation-command compact" onClick={fitCanvas}><Minus size={18} /><span>适应</span></button>
          <button className="annotation-command compact" onClick={() => void toggleFullscreen()}><Maximize2 size={18} /><span>全屏</span></button>
        </div>
      </header>

      <div className={`annotation-status-bar state-${syncState}`}>
        <div className="annotation-breadcrumb"><strong>{dataset.name}</strong><span>{dataset.version} / {annotationImageId}</span></div>
        <div className={`annotation-review-badge status-${reviewStatus}`}><ShieldCheck size={15} /><span>{reviewStatus === 'submitted' ? '待审核' : reviewStatus === 'approved' ? '已通过' : reviewStatus === 'rejected' ? '已驳回' : '草稿'}</span>{reviewComment && <small title={reviewComment}>{reviewComment}</small>}</div>
        <div className="annotation-save-state"><CloudUpload size={15} /><span>{syncState === 'loading' ? '正在加载已保存标注' : syncState === 'saving' ? `正在统一保存 ${dirtyCount} 张图片` : syncState === 'conflict' ? '服务器版本已更新，请处理冲突' : syncState === 'error' ? '同步失败，请重新保存' : editingLocked ? '只读查看' : dirtyCount > 0 ? `${dirtyCount} 张图片待统一保存` : '所有更改已同步'}</span></div>
        {conflict?.imageId === annotationImageId && <div className="annotation-conflict-actions"><button onClick={loadServerVersion}>加载服务器版本</button><button className="primary" onClick={keepCurrentAndOverwrite}>保留当前并覆盖</button></div>}
        <div className="annotation-label-picker">
          <span className="color-dot" style={{ background: activeLabel?.color ?? labelColors[0] }} />
          <select value={activeLabel?.name ?? ''} disabled={!labelOptions.length || editingLocked} onChange={(event) => setActiveLabel(labelOptions.find((item) => item.name === event.target.value) ?? null)}>
            {!labelOptions.length && <option value="">暂无类别</option>}
            {labelOptions.map((label) => <option key={label.name}>{label.name}</option>)}
          </select>
          <button onClick={() => void addClass()} disabled={editingLocked} aria-label="添加类别"><Plus size={15} /></button>
        </div>
        {isReviewMode && !canReview && <div className="annotation-review-permission">当前账号仅可查看审核结果</div>}
      </div>

      <div className="annotation-workspace">
        <aside className="annotation-left-panel">
          {toolOptions.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`annotation-rail-tool ${tool === id ? 'active' : ''}`} onClick={() => activateTool(id)} disabled={editingLocked && id !== 'select'} title={`${label} (${toolShortcuts[id]} / ${toolOptions.findIndex((option) => option.id === id) + 1})`} aria-label={label} aria-keyshortcuts={`${toolShortcuts[id]} ${toolOptions.findIndex((option) => option.id === id) + 1}`}>
              <Icon size={20} /><span>{label}</span>
            </button>
          ))}
          <span className="annotation-rail-divider" />
          <button className="annotation-rail-tool" onClick={resetCurrentImage} disabled={editingLocked} title="重置到已保存版本" aria-label="重置到已保存版本"><RotateCcw size={19} /><span>重置</span></button>
          <button className="annotation-rail-tool danger" onClick={deleteSelected} disabled={editingLocked || !selectedId} title="删除所选对象" aria-label="删除所选对象"><Trash2 size={19} /><span>删除</span></button>
        </aside>

        <main className="annotation-center">
          <div className="annotation-toolbar">
            <span><MousePointer2 size={15} />当前工具：<strong>{toolOptions.find((option) => option.id === tool)?.label}</strong></span>
            {editingLocked ? <span className="annotation-selection-hint">审核模式 · 标注只读</span> : selectedAnnotation && <span className="annotation-selection-hint">拖动对象移动，拖动控制点调整形状</span>}
            {['polygon', 'polyline', 'skeleton'].includes(tool) && polygonPoints.length > 0 && <button className="button compact primary" disabled={polygonPoints.length < (tool === 'polygon' ? 3 : tool === 'skeleton' ? 1 : 2)} onClick={finishPolygon}><Check size={15} />完成{tool === 'polygon' ? '多边形' : tool === 'polyline' ? '折线' : '骨架'} ({polygonPoints.length})</button>}
          </div>

          <div ref={canvasScrollRef} className="canvas-scroll-area" data-testid="annotation-canvas-scroll" aria-label="标注画布，按住 Ctrl 或 Command 并滚动鼠标滚轮可缩放图像">
            <div className="canvas-stage" style={{ width: `${zoom * 100}%`, aspectRatio: imageAspect ?? 1.58 }}>
              {imagePreview ? <img className="canvas-image" src={imagePreview} alt="当前待标注图像" draggable={false} onLoad={(event) => setImageAspect(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)} /> : <div className="canvas-empty-image"><CloudUpload size={28} /><span>正在加载图像预览</span></div>}
              <svg
                ref={svgRef}
                className={`annotation-overlay tool-${tool} ${editingLocked ? 'read-only' : ''}`}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={cancelPointerInteraction}
                onLostPointerCapture={cancelPointerInteraction}
                onClick={handleCanvasClick}
              >
                {annotations.map((annotation) => {
                  if (hiddenIds.includes(annotation.id)) return null;
                  const selected = selectedId === annotation.id;
                  if (annotation.type === 'rect') {
                    return <g key={annotation.id} className="rectangle-annotation">
                      <rect x={annotation.x} y={annotation.y} width={annotation.width} height={annotation.height} className={`annotation-shape ${selected ? 'selected' : ''}`} style={{ stroke: annotation.color, fill: `${annotation.color}24` }} onPointerDown={(event) => beginRectInteraction(event, annotation)} onClick={(event) => { if (tool === 'select') event.stopPropagation(); }} />
                      {selected && tool === 'select' && rectangleHandles.map((handle) => {
                        const point = rectangleHandlePoint(annotation, handle);
                        return <circle key={handle} cx={point.x} cy={point.y} r="0.75" className={`rectangle-handle handle-${handle}`} onPointerDown={(event) => beginRectInteraction(event, annotation, handle)} onClick={(event) => { if (tool === 'select') event.stopPropagation(); }} />;
                      })}
                    </g>;
                  }
                  if (annotation.type === 'polygon') {
                    return <g key={annotation.id}><polygon points={annotation.points.map((point) => `${point.x},${point.y}`).join(' ')} className={`annotation-shape ${selected ? 'selected' : ''}`} style={{ stroke: annotation.color, fill: `${annotation.color}32` }} onPointerDown={(event) => beginShapeMove(event, annotation)} onClick={(event) => { if (tool === 'select') event.stopPropagation(); }} />{selected && tool === 'select' && annotation.points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="0.8" className="shape-edit-handle" onPointerDown={(event) => beginPointEdit(event, annotation, index)} />)}</g>;
                  }
                  if (annotation.type === 'polyline') {
                    return <g key={annotation.id}><polyline points={annotation.points.map((point) => `${point.x},${point.y}`).join(' ')} className={`annotation-shape polyline-shape ${selected ? 'selected' : ''}`} style={{ stroke: annotation.color, strokeWidth: annotation.strokeWidth }} onPointerDown={(event) => beginShapeMove(event, annotation)} onClick={(event) => { if (tool === 'select') event.stopPropagation(); }} />{selected && tool === 'select' && annotation.points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="0.8" className="shape-edit-handle" onPointerDown={(event) => beginPointEdit(event, annotation, index)} />)}</g>;
                  }
                  if (annotation.type === 'ellipse') {
                    return <g key={annotation.id}><ellipse cx={annotation.cx} cy={annotation.cy} rx={annotation.rx} ry={annotation.ry} transform={`rotate(${annotation.rotation} ${annotation.cx} ${annotation.cy})`} className={`annotation-shape ${selected ? 'selected' : ''}`} style={{ stroke: annotation.color, fill: `${annotation.color}28` }} onPointerDown={(event) => beginShapeMove(event, annotation)} onClick={(event) => { if (tool === 'select') event.stopPropagation(); }} />{selected && tool === 'select' && <><circle cx={annotation.cx + annotation.rx} cy={annotation.cy} r="0.8" className="shape-edit-handle handle-e" onPointerDown={(event) => beginEllipseResize(event, annotation, 'x')} /><circle cx={annotation.cx} cy={annotation.cy + annotation.ry} r="0.8" className="shape-edit-handle handle-s" onPointerDown={(event) => beginEllipseResize(event, annotation, 'y')} /></>}</g>;
                  }
                  if (annotation.type === 'skeleton') {
                    const indexed = new Map(annotation.points.map((point) => [point.index, point]));
                    return <g key={annotation.id} className={`skeleton-shape ${selected ? 'selected' : ''}`} onPointerDown={(event) => beginShapeMove(event, annotation)} onClick={(event) => { if (tool === 'select') event.stopPropagation(); }}>{annotation.edges.map(([from, to], index) => { const start = indexed.get(from); const end = indexed.get(to); return start && end ? <line key={index} x1={start.x} y1={start.y} x2={end.x} y2={end.y} style={{ stroke: annotation.color }} /> : null; })}{annotation.points.map((point, index) => <g key={point.index}><circle cx={point.x} cy={point.y} r="1.35" style={{ fill: annotation.color }} />{selected && tool === 'select' && <circle cx={point.x} cy={point.y} r="0.8" className="shape-edit-handle" onPointerDown={(event) => beginPointEdit(event, annotation, index)} />}<text x={point.x + 1.5} y={point.y - 1.5}>{point.index}</text></g>)}</g>;
                  }
                  return <g key={annotation.id} className={`keypoint-shape ${selected ? 'selected' : ''}`} onPointerDown={(event) => beginShapeMove(event, annotation)} onClick={(event) => { if (tool === 'select') event.stopPropagation(); }}><circle cx={annotation.x} cy={annotation.y} r="1.7" style={{ fill: annotation.color }} /><circle cx={annotation.x} cy={annotation.y} r="0.75" fill="white" /><text x={annotation.x + 2} y={annotation.y - 2}>{annotation.index}</text></g>;
                })}
                {draftRect && <rect x={draftRect.x} y={draftRect.y} width={draftRect.width} height={draftRect.height} className="annotation-shape draft" style={{ stroke: draftRect.color, fill: `${draftRect.color}26` }} />}
                {draftEllipse && <ellipse cx={draftEllipse.cx} cy={draftEllipse.cy} rx={draftEllipse.rx} ry={draftEllipse.ry} className="annotation-shape draft" style={{ stroke: draftEllipse.color, fill: `${draftEllipse.color}26` }} />}
                {polygonPoints.length > 0 && <g className="polygon-draft"><polyline points={polygonPoints.map((point) => `${point.x},${point.y}`).join(' ')} style={{ stroke: activeLabel?.color ?? labelColors[0] }} />{polygonPoints.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="0.8" style={{ fill: activeLabel?.color ?? labelColors[0] }} />)}</g>}
                {imageAttributes.crop && <rect className="sdxl-crop-overlay" x={imageAttributes.crop.x} y={imageAttributes.crop.y} width={imageAttributes.crop.width} height={imageAttributes.crop.height} />}
              </svg>
              {selectedAnnotation && <span className="canvas-selection-label" style={{ ...selectionLabelPosition, borderColor: selectedAnnotation.color }}>{selectedAnnotation.label}</span>}
            </div>
          </div>

          <footer className="annotation-footer">
            <div><span>{images.findIndex((image) => image.id === annotationImageId) + 1} / {images.length}</span></div>
            <span>{images.find((image) => image.id === annotationImageId)?.filename ?? annotationImageId}</span>
          </footer>
        </main>

        <aside className="annotation-right-panel">
          <div className="right-panel-tabs"><button className={rightPanelTab === 'objects' ? 'active' : ''} onClick={() => setRightPanelTab('objects')}>对象 <span>{annotations.length}</span></button><button className={rightPanelTab === 'properties' ? 'active' : ''} onClick={() => setRightPanelTab('properties')}>属性</button><button className={rightPanelTab === 'sdxl' ? 'active' : ''} onClick={() => setRightPanelTab('sdxl')}><Tag size={13} />SDXL</button></div>
          {rightPanelTab === 'objects' && <><section className="object-panel-section">
            <header><strong>标注对象</strong><button className="icon-button" title="显示全部" aria-label="显示全部标注" onClick={() => setHiddenIds([])}><Eye size={16} /></button></header>
            <div className="object-list">
              {annotations.map((annotation, index) => {
                const Icon = annotationIcon(annotation.type);
                const hidden = hiddenIds.includes(annotation.id);
                return (
                  <button className={`object-row ${selectedId === annotation.id ? 'selected' : ''}`} key={annotation.id} onClick={() => setSelectedId(annotation.id)}>
                    <span className="object-color" style={{ background: annotation.color }} />
                    <Icon size={15} /><span>{annotation.label} {String(index + 1).padStart(2, '0')}</span>
                    <span className="object-lock" role="button" tabIndex={0} title={annotation.locked ? '解锁对象' : '锁定对象'} onClick={(event) => { event.stopPropagation(); toggleAnnotationLock(annotation.id); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); toggleAnnotationLock(annotation.id); } }}>{annotation.locked ? <Lock size={14} /> : <Unlock size={14} />}</span>
                    <span className="object-visibility" onClick={(event) => { event.stopPropagation(); toggleVisibility(annotation.id); }}>{hidden ? <EyeOff size={15} /> : <Eye size={15} />}</span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="object-panel-section class-section">
            <header><strong>类别</strong><button className="icon-button" aria-label="添加类别" disabled={editingLocked} onClick={() => void addClass()}><Plus size={16} /></button></header>
            {counts.length ? counts.map((label) => <button className={activeLabel?.name === label.name ? 'active' : ''} onClick={() => setActiveLabel(label)} key={label.name}><i style={{ background: label.color }} /><span>{label.name}</span><b>{label.count}</b></button>) : <p className="empty-inline">数据集尚未定义类别</p>}
          </section></>}
          {rightPanelTab !== 'sdxl' && <div className="annotation-inspector">
            <strong>{rightPanelTab === 'properties' ? '对象属性' : '当前选择'}</strong>
            {selectedAnnotation ? <><div><span>类型</span><b>{annotationTypeLabel(selectedAnnotation.type)}</b></div><div><span>类别</span><b>{selectedAnnotation.label}</b></div><div><span>编辑状态</span><b>{selectedAnnotation.locked ? '已锁定' : '可编辑'}</b></div>{selectedAnnotation.type === 'rect' && <div className="rectangle-property-grid">
              {(['x', 'y', 'width', 'height'] as const).map((field) => <label key={field}><span>{field === 'x' ? 'X' : field === 'y' ? 'Y' : field === 'width' ? '宽度' : '高度'}</span><input type="number" min="0" max="100" step="0.1" disabled={editingLocked} value={selectedAnnotation[field].toFixed(1)} onChange={(event) => updateSelectedRectangle(field, Number(event.target.value))} /></label>)}
            </div>}<div className="inspector-actions"><button className="button secondary" disabled={editingLocked} onClick={() => toggleAnnotationLock(selectedAnnotation.id)}>{selectedAnnotation.locked ? <Unlock size={16} /> : <Lock size={16} />}{selectedAnnotation.locked ? '解锁' : '锁定'}</button><button className="button danger ghost" disabled={editingLocked || selectedAnnotation.locked} onClick={deleteSelected}><Trash2 size={16} />删除对象</button></div></> : <p>未选择对象</p>}
          </div>}
          {rightPanelTab === 'sdxl' && <section className="sdxl-caption-panel">
            <header><div><strong>图像文本标注</strong><small>用于 ImageFolder / SDXL 训练</small></div><label className="switch-field"><input type="checkbox" checked={imageAttributes.includeInSdxl} disabled={editingLocked} onChange={(event) => updateImageAttributes({ includeInSdxl: event.target.checked })} /><span>纳入训练</span></label></header>
            <label className="caption-field"><span>主 Caption <b>{imageAttributes.includeInSdxl ? '必填' : '可选'}</b></span><textarea aria-label="SDXL 主 Caption" rows={7} disabled={editingLocked} value={primaryCaption?.text ?? ''} placeholder="例如：a close-up industrial inspection image of a scratched metal surface" onChange={(event) => updatePrimaryCaption(event.target.value)} /><small>{primaryCaption?.text.length ?? 0} 字符 · 约 {primaryCaption?.text.trim() ? primaryCaption.text.trim().split(/\s+/).length : 0} tokens</small></label>
            <label className="sdxl-select-field"><span>语言</span><select aria-label="Caption 语言" disabled={editingLocked || !primaryCaption} value={primaryCaption?.language ?? 'en'} onChange={(event) => updatePrimaryCaption(primaryCaption?.text ?? '', event.target.value as ImageCaption['language'])}><option value="en">English</option><option value="zh">中文</option></select></label>
            <label className="caption-field"><span>图像标签</span><input aria-label="SDXL 图像标签" disabled={editingLocked} value={imageAttributes.tags.join(', ')} placeholder="scratch, metal, close-up" onChange={(event) => updateImageAttributes({ tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} /><small>使用英文逗号分隔，随 metadata.jsonl 导出</small></label>
            <div className="crop-fieldset"><label className="switch-field"><input type="checkbox" checked={Boolean(imageAttributes.crop)} disabled={editingLocked} onChange={(event) => updateImageAttributes({ crop: event.target.checked ? { x: 0, y: 0, width: 100, height: 100 } : undefined })} /><span>训练裁剪区域</span></label>{imageAttributes.crop && <div className="rectangle-property-grid">{(['x', 'y', 'width', 'height'] as const).map((field) => <label key={field}><span>{field.toUpperCase()}</span><input type="number" min="0" max="100" step="0.1" disabled={editingLocked} value={imageAttributes.crop?.[field] ?? 0} onChange={(event) => updateCropField(field, Number(event.target.value))} /></label>)}</div>}</div>
          </section>}
          <div className="annotation-progress"><div><span>{isReviewMode ? '审核进度' : '当前图像标注'}</span><strong>{isReviewMode ? `${reviewSummary?.approved ?? 0}/${reviewSummary?.total ?? images.length}` : annotations.length}</strong></div><ProgressBar value={isReviewMode ? (reviewSummary?.total ? reviewSummary.approved / reviewSummary.total * 100 : 0) : hasImageAnnotation ? 100 : 0} tone="green" /><small>{isReviewMode ? `${reviewSummary?.submitted ?? 0} 张待审核 · ${reviewSummary?.rejected ?? 0} 张已驳回` : hasImageAnnotation ? `${annotations.length} 个对象${primaryCaption?.text.trim() ? ' · 已填写 Caption' : ''}` : '尚未创建标注'}</small></div>
        </aside>
      </div>
    </div>
  );
}
