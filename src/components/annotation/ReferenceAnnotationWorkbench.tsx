import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowLeft,
  BoxSelect,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  CircleDot,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Link2,
  Lock,
  MessageSquare,
  Maximize2,
  Move,
  MoreHorizontal,
  MousePointer2,
  Move3d,
  Pause,
  Pin,
  Pencil,
  Play,
  Redo2,
  RotateCw,
  Save,
  Settings2,
  ShieldAlert,
  SkipBack,
  SkipForward,
  SquareDashedMousePointer,
  Tag,
  Trash2,
  Undo2,
  Unlock,
  UserRound,
  XCircle,
} from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Modal } from '../ui';
import { useApp } from '../../context/AppContext';
import type { AnnotationDocument, AnnotationImageAttributes, AnnotationJob, AnnotationRecord, AnnotationReviewStatus, AnnotationSegment, DatasetImage, DatasetLabel } from '../../types';
import { canvasSizeForImage, clampPoint, toAnnotationRecord, toCanvasShape, translateShape } from './annotationGeometry';
import { nextTrackKeyframe, propagateTrack, type TrackFrame } from './annotationTracks';
import { effectiveUserRoles } from '../../../shared/contracts';

type Tool = 'cursor' | 'move' | 'rectangle' | 'polygon' | 'polyline' | 'points' | 'cuboid';
type DrawingTool = Exclude<Tool, 'cursor' | 'move'>;
type DrawingMode = 'shape' | 'track';
type Panel = 'objects' | 'labels' | 'issues';
type Point = { x: number; y: number };
type CanvasShape = AnnotationRecord;
type Draft = { annotations: CanvasShape[]; captions: AnnotationDocument['captions']; imageAttributes: AnnotationImageAttributes; revision: number; dirty: boolean; reviewStatus: AnnotationReviewStatus; reviewComment?: string };
type DraftAnnotationsSnapshot = Record<string, CanvasShape[]>;
type ShapeDragSession = { pointerId: number; id: string; start: Point; original: CanvasShape };
type HandleDragSession = { pointerId: number; id: string; handle: number; original: CanvasShape };
type PanSession = { pointerId: number; start: Point; origin: Point };

const colors = ['#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1', '#13c2c2'];
const tools: Array<{ id: Tool; label: string; shortcut: string; icon: typeof MousePointer2 }> = [
  { id: 'cursor', label: '光标', shortcut: 'V', icon: MousePointer2 },
  { id: 'move', label: '移动画布', shortcut: 'M', icon: Move },
  { id: 'rectangle', label: '矩形', shortcut: 'R', icon: BoxSelect },
  { id: 'polygon', label: '多边形', shortcut: 'P', icon: SquareDashedMousePointer },
  { id: 'polyline', label: '折线', shortcut: 'N', icon: Pencil },
  { id: 'points', label: '点', shortcut: 'K', icon: CircleDot },
  { id: 'cuboid', label: '立方体', shortcut: 'B', icon: Move3d },
];

const emptyAttributes = { includeInSdxl: false, tags: [] };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function rectangle(start: Point, end: Point) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

function cuboidPointsFromFront(front: Point[], size: ReturnType<typeof canvasSizeForImage>): Point[] {
  const left = Math.min(...front.map((point) => point.x));
  const right = Math.max(...front.map((point) => point.x));
  const top = Math.min(...front.map((point) => point.y));
  const bottom = Math.max(...front.map((point) => point.y));
  const depthX = Math.max(2, (right - left) * 0.18);
  const depthY = Math.max(2, (bottom - top) * 0.18);
  return [...front, ...front.map((point) => clampPoint({ x: point.x + depthX, y: point.y - depthY }, size))];
}

function cuboidPoints(box: ReturnType<typeof rectangle>, size: ReturnType<typeof canvasSizeForImage>): Point[] {
  const front = [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }];
  return cuboidPointsFromFront(front, size);
}

function pointFromEvent(event: Pick<PointerEvent, 'clientX' | 'clientY'> | Pick<ReactPointerEvent<SVGSVGElement>, 'clientX' | 'clientY'>, svg: SVGSVGElement | null, size: ReturnType<typeof canvasSizeForImage>): Point {
  const screenTransform = svg?.getScreenCTM?.();
  if (screenTransform) {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(screenTransform.inverse());
    return clampPoint({ x: point.x, y: point.y }, size);
  }
  const bounds = svg?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1, height: 1 };
  return clampPoint({ x: ((event.clientX - bounds.left) / bounds.width) * size.width, y: ((event.clientY - bounds.top) / bounds.height) * size.height }, size);
}

function labelFor(datasetLabels: DatasetLabel[] | undefined, classes: string[], active: string | undefined, index: number) {
  const labels = datasetLabels?.length ? datasetLabels : classes.map((name, i) => ({ name, color: colors[i % colors.length], attributes: [] }));
  return labels.find((label) => label.name === active) ?? labels[index % Math.max(1, labels.length)];
}

function shapeLabel(shape: CanvasShape) {
  return shape.label || '未命名';
}

function geometryLabel(shape: CanvasShape) {
  return shape.geometry.type === 'rectangle' ? '矩形' : shape.geometry.type === 'polygon' ? '多边形' : shape.geometry.type === 'polyline' ? '折线' : shape.geometry.type === 'keypoint' ? '点' : shape.geometry.type === 'cuboid' ? '立方体' : shape.geometry.type;
}

export function ReferenceAnnotationWorkbench() {
  const { datasetId = '', jobId: routeJobId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const imageId = searchParams.get('image') ?? '';
  const isReviewMode = searchParams.get('mode') === 'review';
  const reviewJobId = searchParams.get('job') ?? routeJobId;
  const { datasets, annotationJobs, annotationSegments, claimNextAnnotationJob, claimAnnotationReviewJob, claimNextAnnotationReviewJob, datasetImages, datasetImagePreview, loadAnnotationDocument, saveAnnotationDocument, saveReviewedAnnotation, submitAnnotationJob, reviewAnnotationJob, session, notify } = useApp();
  const dataset = datasets.find((item) => item.id === datasetId);
  const isReviewer = Boolean(session && effectiveUserRoles(session.user).some((role) => role === 'admin' || role === 'reviewer'));
  const svgRef = useRef<SVGSVGElement>(null);
  const draftRef = useRef<Record<string, Draft>>({});
  const draftCanvasSizesRef = useRef<Record<string, ReturnType<typeof canvasSizeForImage>>>({});
  const currentDraftRef = useRef<Draft>({ annotations: [], captions: [], imageAttributes: emptyAttributes, revision: 0, dirty: false, reviewStatus: 'draft' });
  const saveInFlightRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const saveSubmitQueuedRef = useRef(false);
  const saveNoticeQueuedRef = useRef(false);
  const draftVersionRef = useRef(0);
  const shapeDragRef = useRef<ShapeDragSession | null>(null);
  const handleDragRef = useRef<HandleDragSession | null>(null);
  const panRef = useRef<PanSession | null>(null);
  const historyRef = useRef<CanvasShape[][]>([]);
  const futureRef = useRef<CanvasShape[][]>([]);
  const historyDraftsRef = useRef<DraftAnnotationsSnapshot[]>([]);
  const futureDraftsRef = useRef<DraftAnnotationsSnapshot[]>([]);
  const clipboardRef = useRef<CanvasShape | undefined>(undefined);
  const [images, setImages] = useState<DatasetImage[]>([]);
  const [segments, setSegments] = useState<AnnotationSegment[]>([]);
  const [job, setJob] = useState<AnnotationJob>();
  const [reviewJob, setReviewJob] = useState<AnnotationJob>();
  const [annotations, setAnnotations] = useState<CanvasShape[]>([]);
  const [captions, setCaptions] = useState<AnnotationDocument['captions']>([]);
  const [imageAttributes, setImageAttributes] = useState<AnnotationImageAttributes>(emptyAttributes);
  const [revision, setRevision] = useState(0);
  const [reviewStatus, setReviewStatus] = useState<AnnotationReviewStatus>('draft');
  const [reviewComment, setReviewComment] = useState<string>();
  const [preview, setPreview] = useState<{ imageId: string; url: string }>();
  const [previewReadyId, setPreviewReadyId] = useState<string>();
  const [documentReadyId, setDocumentReadyId] = useState<string>();
  const [previewDimensions, setPreviewDimensions] = useState<Record<string, ReturnType<typeof canvasSizeForImage>>>({});
  const [tool, setTool] = useState<Tool>('cursor');
  const [panel, setPanel] = useState<Panel>('objects');
  const [selectedId, setSelectedId] = useState<string>();
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [lockedIds, setLockedIds] = useState<string[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [draftPoints, setDraftPoints] = useState<Point[]>([]);
  const [draftCursor, setDraftCursor] = useState<Point>();
  const [setupTool, setSetupTool] = useState<DrawingTool>();
  const [drawingTool, setDrawingTool] = useState<DrawingTool>();
  const [drawingMode, setDrawingMode] = useState<DrawingMode>('shape');
  const [trackLoading, setTrackLoading] = useState(false);
  const [pointCount, setPointCount] = useState('');
  const [rectangleMethod, setRectangleMethod] = useState<'two' | 'four'>('two');
  const [cuboidMethod, setCuboidMethod] = useState<'rectangle' | 'four'>('rectangle');
  const [syncState, setSyncState] = useState<'loading' | 'saved' | 'dirty' | 'saving' | 'error'>('loading');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [dialog, setDialog] = useState<'shortcuts' | 'settings' | 'info' | 'review' | null>(null);
  const [playing, setPlaying] = useState(false);
  const [workbenchLoadState, setWorkbenchLoadState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [showGrid, setShowGrid] = useState(false);
  const [opacity, setOpacity] = useState(100);
  const [showLabels, setShowLabels] = useState(true);
  const [showOutlines, setShowOutlines] = useState(true);
  const [showProjections, setShowProjections] = useState(false);
  const [colorDimension, setColorDimension] = useState<'label' | 'instance' | 'group'>('label');
  const [objectsOpen, setObjectsOpen] = useState(false);
  const [workspace, setWorkspace] = useState<'standard' | 'attributes' | 'tags'>('standard');
  const [tagInput, setTagInput] = useState('');
  const [canvasViewportWidth, setCanvasViewportWidth] = useState(1100);

  const currentJob = reviewJob ?? job;
  const activeSegment = currentJob ? segments.find((segment) => segment.id === currentJob.segmentId) : undefined;
  const workImages = useMemo(() => {
    const ordered = [...images].sort((left, right) => (left.extractionOrder ?? Number.MAX_SAFE_INTEGER) - (right.extractionOrder ?? Number.MAX_SAFE_INTEGER) || left.createdAt.localeCompare(right.createdAt));
    if (!activeSegment) return ordered;
    const start = ordered.findIndex((item) => item.id === activeSegment.startItemId);
    return start >= 0 ? ordered.slice(start, start + activeSegment.itemCount) : ordered;
  }, [activeSegment, images]);
  const currentIndex = workImages.findIndex((item) => item.id === imageId);
  const currentImage = workImages[currentIndex];
  const canvasSize = previewDimensions[imageId] ?? canvasSizeForImage(currentImage);
  const canvasUnitScale = canvasSize.width / Math.max(1, canvasViewportWidth * zoom);
  const annotationLabelFontSize = 16.8 * canvasUnitScale;
  const annotationLabelGap = 4 * canvasUnitScale;
  const handleRadius = 4 * canvasUnitScale;
  const isLastSegmentFrame = currentIndex >= 0 && (activeSegment ? imageId === activeSegment.endItemId : currentIndex === workImages.length - 1);
  const editingLocked = isReviewMode ? !reviewJob || reviewJob.reviewerId !== session?.user.id || reviewJob.status !== 'reviewing' : Boolean(currentJob && (currentJob.assigneeId && currentJob.assigneeId !== session?.user.id || ['submitted', 'approved'].includes(currentJob.status))) || reviewStatus === 'submitted' || reviewStatus === 'approved';
  const labels = dataset?.labels?.length ? dataset.labels : dataset?.classes?.map((name, index) => ({ name, color: colors[index % colors.length], attributes: [] })) ?? [];
  const selectedLabelName = searchParams.get('label') ?? undefined;
  const objectId = searchParams.get('object') ?? undefined;
  const activeLabel = labelFor(dataset?.labels, dataset?.classes ?? [], selectedLabelName, 0);
  const selected = annotations.find((item) => item.id === selectedId);
  const frameReady = previewReadyId === imageId && documentReadyId === imageId;
  const dirty = syncState === 'dirty';
  const currentDraft = useMemo<Draft>(() => ({ annotations, captions, imageAttributes, revision, dirty, reviewStatus, reviewComment }), [annotations, captions, dirty, imageAttributes, revision, reviewComment, reviewStatus]);
  currentDraftRef.current = currentDraft;

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateViewportWidth = () => {
      const width = svg.clientWidth || svg.getBoundingClientRect().width / Math.max(0.1, zoom);
      if (width > 0) setCanvasViewportWidth((current) => Math.abs(current - width) < 0.5 ? current : width);
    };
    updateViewportWidth();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateViewportWidth);
    observer?.observe(svg);
    window.addEventListener('resize', updateViewportWidth);
    return () => { observer?.disconnect(); window.removeEventListener('resize', updateViewportWidth); };
  }, [canvasSize.height, canvasSize.width, workbenchLoadState, zoom]);

  const draftAnnotationsSnapshot = () => Object.fromEntries(Object.entries(draftRef.current).map(([id, draft]) => [id, clone(draft.annotations)]));
  const recordHistory = (previous: CanvasShape[]) => {
    historyRef.current.push(clone(previous));
    historyDraftsRef.current.push(draftAnnotationsSnapshot());
    if (historyRef.current.length > 100) { historyRef.current.shift(); historyDraftsRef.current.shift(); }
    futureRef.current = [];
    futureDraftsRef.current = [];
  };
  const restoreDraftAnnotations = (snapshot: DraftAnnotationsSnapshot) => {
    Object.keys(draftRef.current).forEach((id) => { if (!snapshot[id]) delete draftRef.current[id]; });
    Object.entries(snapshot).forEach(([id, annotationsForFrame]) => {
      const draft = draftRef.current[id];
      if (draft) draftRef.current[id] = { ...draft, annotations: clone(annotationsForFrame), dirty: true };
    });
  };

  const loadAllDrafts = useCallback(async () => {
    if (!dataset) return;
    setTrackLoading(true);
    const requestedVersion = draftVersionRef.current;
    try {
      await Promise.all(workImages.map(async (image) => {
        if (draftRef.current[image.id]) return;
        const document = await loadAnnotationDocument(dataset.id, image.id);
        if (draftRef.current[image.id]?.dirty || (image.id === imageId && draftVersionRef.current !== requestedVersion)) return;
        const size = previewDimensions[image.id] ?? canvasSizeForImage(image);
        draftCanvasSizesRef.current[image.id] = size;
        draftRef.current[image.id] = { annotations: document.annotations.map((item) => toCanvasShape(item, size)), captions: document.captions, imageAttributes: document.imageAttributes, revision: document.revision, dirty: false, reviewStatus: document.reviewStatus, reviewComment: document.reviewComment };
      }));
    } finally {
      setTrackLoading(false);
    }
  }, [dataset, imageId, loadAnnotationDocument, previewDimensions, workImages]);

  const commitAnnotations = useCallback((next: CanvasShape[], previous = annotations, trackIds: string[] = []) => {
    recordHistory(previous);
    draftVersionRef.current += 1;
    if (imageId) draftRef.current[imageId] = { ...currentDraftRef.current, annotations: clone(next), dirty: true };
    if (trackIds.length && imageId) {
      let frames: TrackFrame[] = workImages.flatMap((image, frameIndex) => {
        const draft = draftRef.current[image.id];
        return draft ? [{ imageId: image.id, frameIndex, annotations: draft.annotations }] : [];
      });
      if (frames.length !== workImages.length) {
        setAnnotations(next);
        setSyncState('dirty');
        notify('追踪未完成', '任务段仍有图像加载失败，当前帧已保留，请重试追踪', 'error');
        return;
      }
      const incompatibleFrames = new Set<number>();
      trackIds.forEach((trackId) => {
        const result = propagateTrack(frames, trackId);
        frames = result.frames;
        result.incompatibleFrames.forEach((frameIndex) => incompatibleFrames.add(frameIndex));
      });
      frames.forEach((frame) => {
        const draft = draftRef.current[frame.imageId];
        if (draft) draftRef.current[frame.imageId] = { ...draft, annotations: clone(frame.annotations), dirty: true };
      });
      const currentFrame = frames.find((frame) => frame.imageId === imageId);
      setAnnotations(currentFrame?.annotations ?? next);
      if (incompatibleFrames.size) notify('追踪未覆盖全部帧', '关键帧的多边形或折线点数不一致，冲突帧保留原标注', 'info');
    } else {
      setAnnotations(next);
    }
    setSyncState('dirty');
  }, [annotations, imageId, notify, workImages]);

  useEffect(() => {
    if (!datasetId) return;
    let active = true;
    setWorkbenchLoadState('loading');
    const load = async () => {
      let [imageList, segmentList, jobList] = await Promise.all([datasetImages(datasetId), annotationSegments(datasetId), annotationJobs(datasetId)]);
      let selectedJob = jobList.find((item) => item.id === routeJobId) ?? jobList.find((item) => item.assigneeId === session?.user.id && ['claimed', 'in_progress', 'rework'].includes(item.status));
      let selectedReviewJob = isReviewMode ? jobList.find((item) => item.id === reviewJobId) : undefined;
      if (isReviewMode && isReviewer && (!selectedReviewJob || selectedReviewJob.status === 'submitted')) {
        const claimedReviewJob = selectedReviewJob
          ? await claimAnnotationReviewJob(selectedReviewJob.id)
          : await claimNextAnnotationReviewJob(datasetId);
        if (claimedReviewJob) {
          [imageList, segmentList, jobList] = await Promise.all([datasetImages(datasetId), annotationSegments(datasetId), annotationJobs(datasetId)]);
          selectedReviewJob = claimedReviewJob;
        }
      }
      if (!isReviewer && !isReviewMode && !routeJobId && !selectedJob && jobList.some((item) => item.status === 'available')) {
        const claimedJob = await claimNextAnnotationJob(datasetId);
        if (claimedJob) {
          [imageList, segmentList, jobList] = await Promise.all([datasetImages(datasetId), annotationSegments(datasetId), annotationJobs(datasetId)]);
          selectedJob = jobList.find((item) => item.id === claimedJob.id) ?? claimedJob;
        }
      }
      if (!active) return;
      setImages(imageList); setSegments(segmentList);
      if (isReviewMode) setReviewJob(selectedReviewJob); else setJob(selectedJob);
      const activeJob = isReviewMode ? selectedReviewJob : selectedJob;
      const segment = activeJob ? segmentList.find((item) => item.id === activeJob.segmentId) : undefined;
      if (isReviewMode && !activeJob) {
        setWorkbenchLoadState('empty');
        return;
      }
      const first = segment ? imageList.find((item) => item.id === segment.startItemId) : imageList[0];
      const nextImageId = imageId && imageList.some((item) => item.id === imageId) ? imageId : first?.id;
      if (!nextImageId) {
        setWorkbenchLoadState('empty');
        return;
      }
      setWorkbenchLoadState('ready');
      if (nextImageId !== imageId) setSearchParams(isReviewMode ? { image: nextImageId, mode: 'review', ...(activeJob?.id ? { job: activeJob.id } : {}) } : { image: nextImageId });
    };
    void load().catch((error: unknown) => {
      if (!active) return;
      setWorkbenchLoadState('error');
      notify('标注任务加载失败', error instanceof Error ? error.message : '无法读取任务数据', 'error');
    });
    return () => { active = false; };
  }, [annotationJobs, annotationSegments, claimAnnotationReviewJob, claimNextAnnotationJob, claimNextAnnotationReviewJob, datasetId, datasetImages, imageId, isReviewer, isReviewMode, notify, reviewJobId, routeJobId, session?.user.id, setSearchParams]);

  useEffect(() => {
    if (!dataset || !imageId) return;
    let active = true;
    const requestedVersion = draftVersionRef.current;
    const stored = draftRef.current[imageId];
    const storedSize = draftCanvasSizesRef.current[imageId];
    const sizeChanged = Boolean(storedSize && (storedSize.width !== canvasSize.width || storedSize.height !== canvasSize.height));
    const currentStored = stored && sizeChanged && storedSize
      ? { ...stored, annotations: stored.annotations.map((shape) => toCanvasShape(toAnnotationRecord(shape, storedSize), canvasSize)) }
      : stored;
    setDocumentReadyId(currentStored ? imageId : undefined);
    if (currentStored && currentStored !== stored) draftRef.current[imageId] = currentStored;
    draftCanvasSizesRef.current[imageId] = canvasSize;
    historyRef.current = []; futureRef.current = []; historyDraftsRef.current = []; futureDraftsRef.current = []; shapeDragRef.current = null; handleDragRef.current = null;
    setDraftPoints([]); setDraftCursor(undefined); setSetupTool(undefined); setHiddenIds([]); setLockedIds([]); setPinnedIds([]);
    setSyncState(stored?.dirty ? 'dirty' : 'loading');
    if (currentStored) {
      setAnnotations(currentStored.annotations); setCaptions(currentStored.captions); setImageAttributes(currentStored.imageAttributes); setRevision(currentStored.revision); setReviewStatus(currentStored.reviewStatus); setReviewComment(currentStored.reviewComment); setSelectedId(currentStored.annotations.find((item) => item.id === objectId)?.id ?? currentStored.annotations[0]?.id); setSyncState(currentStored.dirty ? 'dirty' : 'saved');
    } else {
      void loadAnnotationDocument(dataset.id, imageId).then((document) => {
        if (!active) return;
        if (draftRef.current[imageId]?.dirty || draftVersionRef.current !== requestedVersion) return;
        const next = { annotations: document.annotations.map((item) => toCanvasShape(item, canvasSize)), captions: document.captions, imageAttributes: document.imageAttributes, revision: document.revision, dirty: false, reviewStatus: document.reviewStatus, reviewComment: document.reviewComment };
        draftCanvasSizesRef.current[imageId] = canvasSize;
        draftRef.current[imageId] = next; setAnnotations(next.annotations); setCaptions(next.captions); setImageAttributes(next.imageAttributes); setRevision(next.revision); setReviewStatus(next.reviewStatus); setReviewComment(next.reviewComment); setSelectedId(next.annotations.find((item) => item.id === objectId)?.id ?? next.annotations[0]?.id); setSyncState('saved');
        setDocumentReadyId(imageId);
      }).catch(() => { if (active) setSyncState('error'); });
    }
    return () => { active = false; };
  }, [canvasSize.height, canvasSize.width, dataset?.id, imageId, loadAnnotationDocument, objectId]);

  useEffect(() => {
    if (!dataset || !imageId) return;
    let active = true;
    setPreviewReadyId(undefined);
    void datasetImagePreview(dataset.id, imageId).then((url) => { if (active) setPreview({ imageId, url }); else URL.revokeObjectURL(url); }).catch(() => undefined);
    return () => { active = false; setPreview(undefined); };
  }, [dataset?.id, datasetImagePreview, imageId]);

  const markDirty = useCallback((next: CanvasShape[], previous = annotations) => {
    recordHistory(previous);
    draftVersionRef.current += 1;
    setAnnotations(next); setSyncState('dirty');
    if (imageId) draftRef.current[imageId] = { ...currentDraftRef.current, annotations: clone(next), dirty: true };
  }, [annotations, imageId]);

  const commitChangedAnnotations = useCallback((next: CanvasShape[], previous = annotations) => {
    const previousById = new Map(previous.map((shape) => [shape.id, shape]));
    const changed = next.filter((shape) => JSON.stringify(shape) !== JSON.stringify(previousById.get(shape.id)));
    const changedIds = new Set(changed.map((shape) => shape.id));
    const trackIds = [...new Set(changed.flatMap((shape) => shape.trackId ? [shape.trackId] : []))];
    if (!trackIds.length) {
      markDirty(next, previous);
      return;
    }
    const promoted = next.map((shape) => changedIds.has(shape.id) && shape.trackId ? { ...shape, keyframe: true, provenance: 'manual' as const } : shape);
    void loadAllDrafts().then(() => commitAnnotations(promoted, previous, trackIds)).catch((error: unknown) => notify('追踪更新失败', error instanceof Error ? error.message : '无法读取任务段图像', 'error'));
  }, [annotations, commitAnnotations, loadAllDrafts, markDirty, notify]);

  const toPoint = (event: Pick<PointerEvent, 'clientX' | 'clientY'> | Pick<ReactPointerEvent<SVGSVGElement>, 'clientX' | 'clientY'>) => pointFromEvent(event, svgRef.current, canvasSize);
  const updateDraft = (next: Point[]) => setDraftPoints(next);
  const finishPath = useCallback((points = draftPoints) => {
    if (editingLocked || drawingTool !== tool || points.length < (tool === 'polygon' ? 3 : 2) || !['polygon', 'polyline'].includes(tool)) return;
    const label = activeLabel ?? { name: '未命名', color: colors[0], attributes: [] };
    const trackId = drawingMode === 'track' ? createId('track') : undefined;
    const next: CanvasShape = { id: `${tool}-${Date.now()}`, label: label.name, color: label.color, geometry: tool === 'polygon' ? { type: 'polygon', points } : { type: 'polyline', points, strokeWidth: 1 }, attributes: Object.fromEntries(label.attributes.map((attribute) => [attribute.name, attribute.type === 'boolean' ? false : attribute.type === 'integer' ? 0 : ''])), provenance: 'manual', ...(trackId ? { trackId, keyframe: true } : {}) };
    commitAnnotations([...annotations, next], annotations, trackId ? [trackId] : []); setSelectedId(next.id); setDraftPoints([]); setDraftCursor(undefined); setSetupTool(undefined);
  }, [activeLabel, annotations, commitAnnotations, drawingMode, draftPoints, drawingTool, editingLocked, tool]);

  const finishBox = useCallback((points: Point[]) => {
    if (editingLocked || drawingTool !== tool || !['rectangle', 'cuboid'].includes(tool)) return;
    const label = activeLabel ?? { name: '未命名', color: colors[0], attributes: [] };
    const geometry = tool === 'rectangle'
      ? rectangleMethod === 'four' ? { type: 'polygon' as const, points } : { type: 'rectangle' as const, ...rectangle(points[0], points[1]) }
      : cuboidMethod === 'four' ? { type: 'cuboid' as const, points: cuboidPointsFromFront(points, canvasSize) } : { type: 'cuboid' as const, points: cuboidPoints(rectangle(points[0], points[1]), canvasSize) };
    const trackId = drawingMode === 'track' ? createId('track') : undefined;
    const next: CanvasShape = { id: `${tool}-${Date.now()}`, label: label.name, color: label.color, geometry, attributes: {}, provenance: 'manual', ...(trackId ? { trackId, keyframe: true } : {}) };
    commitAnnotations([...annotations, next], annotations, trackId ? [trackId] : []); setSelectedId(next.id); setDraftPoints([]); setDraftCursor(undefined); setSetupTool(undefined);
  }, [activeLabel, annotations, canvasSize, commitAnnotations, cuboidMethod, drawingMode, drawingTool, editingLocked, rectangleMethod, tool]);

  const finishPoints = useCallback((points = draftPoints) => {
    if (editingLocked || drawingTool !== 'points' || !points.length) return;
    const label = activeLabel ?? { name: '未命名', color: colors[0], attributes: [] };
    const keypointOffset = annotations.filter((item) => item.geometry.type === 'keypoint').length;
    const next = points.map((point, index): CanvasShape => {
      const trackId = drawingMode === 'track' ? createId('track') : undefined;
      return { id: `point-${Date.now()}-${index}`, label: label.name, color: label.color, geometry: { type: 'keypoint', x: point.x, y: point.y, index: keypointOffset + index + 1 }, attributes: {}, provenance: 'manual', ...(trackId ? { trackId, keyframe: true } : {}) };
    });
    commitAnnotations([...annotations, ...next], annotations, next.flatMap((item) => item.trackId ? [item.trackId] : [])); setSelectedId(next.at(-1)?.id); setDraftPoints([]); setDraftCursor(undefined); setSetupTool(undefined);
  }, [activeLabel, annotations, commitAnnotations, draftPoints, drawingMode, drawingTool, editingLocked]);

  const selectTool = (nextTool: Tool) => {
    setTool(nextTool);
    setSetupTool(nextTool === 'cursor' || nextTool === 'move' ? undefined : nextTool);
    setDrawingTool(undefined); setDrawingMode('shape');
    setDraftPoints([]);
    setDraftCursor(undefined);
  };

  const startDrawing = async (nextTool: DrawingTool, mode: DrawingMode = 'shape') => {
    if (editingLocked) return;
    if (mode === 'track') {
      try { await loadAllDrafts(); } catch (error) { notify('追踪准备失败', error instanceof Error ? error.message : '无法读取任务段图像', 'error'); return; }
    }
    setDrawingMode(mode);
    setTool(nextTool); setSetupTool(undefined); setDrawingTool(nextTool); setDraftPoints([]); setDraftCursor(undefined);
  };

  const resizeShape = (shape: CanvasShape, handle: number, point: Point): CanvasShape => {
    const geometry = shape.geometry;
    if (geometry.type === 'rectangle') {
      const nextPoint = clampPoint(point, canvasSize);
      let left = geometry.x;
      let right = geometry.x + geometry.width;
      let top = geometry.y;
      let bottom = geometry.y + geometry.height;
      if ([0, 6, 7].includes(handle)) left = Math.min(nextPoint.x, right - 1);
      if ([2, 3, 4].includes(handle)) right = Math.max(nextPoint.x, left + 1);
      if ([0, 1, 2].includes(handle)) top = Math.min(nextPoint.y, bottom - 1);
      if ([4, 5, 6].includes(handle)) bottom = Math.max(nextPoint.y, top + 1);
      return { ...shape, geometry: { ...geometry, x: left, y: top, width: right - left, height: bottom - top } };
    }
    if (geometry.type === 'keypoint') return { ...shape, geometry: { ...geometry, ...clampPoint(point, canvasSize) } };
    if (geometry.type === 'polygon' || geometry.type === 'polyline' || geometry.type === 'cuboid') {
      return { ...shape, geometry: { ...geometry, points: geometry.points.map((item, index) => index === handle ? clampPoint(point, canvasSize) : item) } };
    }
    return shape;
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (tool === 'move') {
      panRef.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: pan };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (drawingTool && ['polygon', 'polyline', 'rectangle', 'cuboid'].includes(drawingTool) && !editingLocked && (draftPoints.length > 0 || ['polygon', 'polyline'].includes(drawingTool))) {
      setDraftCursor(toPoint(event));
      return;
    }
    const panSession = panRef.current;
    if (panSession && (!event.pointerId || panSession.pointerId === event.pointerId)) {
      setPan({ x: panSession.origin.x + event.clientX - panSession.start.x, y: panSession.origin.y + event.clientY - panSession.start.y });
      return;
    }
    const handleDrag = handleDragRef.current;
    if (handleDrag && (!event.pointerId || handleDrag.pointerId === event.pointerId)) {
      const point = toPoint(event);
      setAnnotations((current) => current.map((shape) => shape.id === handleDrag.id ? resizeShape(handleDrag.original, handleDrag.handle, point) : shape));
      return;
    }
    const drag = shapeDragRef.current;
    if (drag && (!event.pointerId || drag.pointerId === event.pointerId)) {
      const point = toPoint(event);
      const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
      setAnnotations((current) => current.map((shape) => shape.id === drag.id ? translateShape(drag.original, delta, canvasSize) : shape));
      return;
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const panSession = panRef.current;
    if (panSession && (!event.pointerId || panSession.pointerId === event.pointerId)) {
      panRef.current = null;
      return;
    }
    const handleDrag = handleDragRef.current;
    if (handleDrag && (!event.pointerId || handleDrag.pointerId === event.pointerId)) {
      handleDragRef.current = null;
      const next = annotations.map((shape) => shape.id === handleDrag.id ? resizeShape(handleDrag.original, handleDrag.handle, toPoint(event)) : shape);
      const previous = annotations.map((shape) => shape.id === handleDrag.id ? handleDrag.original : shape);
      if (JSON.stringify(next) !== JSON.stringify(previous)) commitChangedAnnotations(next, previous);
      return;
    }
    const drag = shapeDragRef.current;
    if (drag && (!event.pointerId || drag.pointerId === event.pointerId)) {
      shapeDragRef.current = null;
      const point = toPoint(event);
      const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
      const next = annotations.map((shape) => shape.id === drag.id ? translateShape(drag.original, delta, canvasSize) : shape);
      const previous = annotations.map((shape) => shape.id === drag.id ? drag.original : shape);
      if (delta.x !== 0 || delta.y !== 0) commitChangedAnnotations(next, previous);
      return;
    }
  };

  const handlePointerCancel = () => {
    const drag = shapeDragRef.current;
    const handleDrag = handleDragRef.current;
    if (drag) setAnnotations((current) => current.map((shape) => shape.id === drag.id ? drag.original : shape));
    if (handleDrag) setAnnotations((current) => current.map((shape) => shape.id === handleDrag.id ? handleDrag.original : shape));
    shapeDragRef.current = null; handleDragRef.current = null; panRef.current = null;
    setDraftPoints([]); setDraftCursor(undefined); setSetupTool(undefined); setDrawingTool(undefined); setTool('cursor');
  };

  const handleCanvasClick = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (editingLocked) return;
    if (drawingTool !== tool) return;
    if (tool === 'points') {
      const point = toPoint(event);
      const nextPoints = [...draftPoints, point];
      const pointTarget = Number(pointCount);
      if (Number.isInteger(pointTarget) && pointTarget >= 1 && nextPoints.length >= pointTarget) { finishPoints(nextPoints); return; }
      updateDraft(nextPoints); setDraftCursor(undefined); return;
    }
    if (tool === 'rectangle' || tool === 'cuboid') {
      const point = toPoint(event);
      const nextPoints = [...draftPoints, point];
      const requiredPoints = tool === 'rectangle' ? rectangleMethod === 'four' ? 4 : 2 : cuboidMethod === 'four' ? 4 : 2;
      if (nextPoints.length >= requiredPoints) { finishBox(nextPoints); return; }
      updateDraft(nextPoints); setDraftCursor(point); return;
    }
    if (tool === 'polygon' || tool === 'polyline') {
      const point = toPoint(event);
      if (event.detail === 2) {
        const last = draftPoints.at(-1);
        finishPath(last && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01 ? draftPoints : [...draftPoints, point]);
        return;
      }
      const nextPoints = [...draftPoints, point];
      const pointTarget = Number(pointCount);
      const minimum = tool === 'polygon' ? 3 : 2;
      if (Number.isInteger(pointTarget) && pointTarget >= minimum && nextPoints.length >= pointTarget) {
        finishPath(nextPoints);
        return;
      }
      updateDraft(nextPoints); setDraftCursor(point);
      return;
    }
    if (tool === 'cursor') {
      const target = (event.target as Element).closest('[data-shape-id]')?.getAttribute('data-shape-id'); setSelectedId(target ?? undefined);
    }
  };

  const setImage = useCallback((index: number) => {
    const target = workImages[index];
    if (!target || syncState === 'saving' || draftPoints.length) return;
    if (imageId && syncState === 'dirty') draftRef.current[imageId] = { ...currentDraftRef.current, dirty: true };
    setSearchParams({ image: target.id, ...(isReviewMode ? { mode: 'review', ...(reviewJobId ? { job: reviewJobId } : {}) } : {}), ...(selectedLabelName ? { label: selectedLabelName } : {}) });
  }, [draftPoints.length, imageId, isReviewMode, reviewJobId, selectedLabelName, setSearchParams, syncState, workImages]);

  useEffect(() => {
    if (!playing) return;
    if (currentIndex < 0 || currentIndex >= workImages.length - 1) { setPlaying(false); return; }
    const timer = window.setInterval(() => setImage(currentIndex + 1), 250);
    return () => window.clearInterval(timer);
  }, [currentIndex, playing, setImage, workImages.length]);

  const saveAll = useCallback(async (submit = false, announce = false): Promise<boolean> => {
    if (!dataset || !imageId || editingLocked) return false;
    if (submit && !isLastSegmentFrame) { notify('暂不能提交', '请先完成当前任务段的最后一帧', 'info'); return false; }
    if (saveInFlightRef.current) { saveQueuedRef.current = true; saveSubmitQueuedRef.current ||= submit; saveNoticeQueuedRef.current ||= announce; return false; }
    const snapshot = clone(currentDraftRef.current); const pending = { ...draftRef.current, [imageId]: { ...snapshot, dirty: snapshot.dirty || submit } }; const segmentImageIds = new Set(workImages.map((image) => image.id)); const dirtyItems = Object.entries(pending).filter(([savedImageId, item]) => segmentImageIds.has(savedImageId) && item.dirty);
    if (!dirtyItems.length && !submit) { if (announce) notify('标注已保存', '当前任务段没有待保存的标注', 'success'); return true; }
    saveInFlightRef.current = true; setSyncState('saving'); let changed = false; let movedToNextJob = false;
    try {
      for (const [savedImageId, item] of dirtyItems) {
        const savedSize = previewDimensions[savedImageId] ?? canvasSizeForImage(workImages.find((image) => image.id === savedImageId));
        const document = isReviewMode && reviewJob ? await saveReviewedAnnotation(reviewJob.id, savedImageId, { revision: item.revision, annotations: item.annotations.map((shape) => toAnnotationRecord(shape, savedSize)), captions: item.captions, imageAttributes: item.imageAttributes }) : await saveAnnotationDocument({ datasetId: dataset.id, imageId: savedImageId, revision: item.revision, annotations: item.annotations.map((shape) => toAnnotationRecord(shape, savedSize)), captions: item.captions, imageAttributes: item.imageAttributes });
        const latestDraft = savedImageId === imageId ? currentDraftRef.current : draftRef.current[savedImageId];
        const changedDuringSave = Boolean(latestDraft && (JSON.stringify(latestDraft.annotations) !== JSON.stringify(item.annotations) || JSON.stringify(latestDraft.captions) !== JSON.stringify(item.captions) || JSON.stringify(latestDraft.imageAttributes) !== JSON.stringify(item.imageAttributes)));
        if (changedDuringSave && latestDraft) {
          changed = true;
          draftRef.current[savedImageId] = { ...latestDraft, revision: document.revision, dirty: true };
          if (savedImageId === imageId) setRevision(document.revision);
        } else {
          draftCanvasSizesRef.current[savedImageId] = savedSize;
          draftRef.current[savedImageId] = { annotations: document.annotations.map((item) => toCanvasShape(item, savedSize)), captions: document.captions, imageAttributes: document.imageAttributes, revision: document.revision, dirty: false, reviewStatus: document.reviewStatus, reviewComment: document.reviewComment };
          if (savedImageId === imageId) { setAnnotations(document.annotations.map((item) => toCanvasShape(item, savedSize))); setCaptions(document.captions); setImageAttributes(document.imageAttributes); setRevision(document.revision); setReviewStatus(document.reviewStatus); setReviewComment(document.reviewComment); }
        }
      }
      if (submit && job && !isReviewMode) {
        const updated = await submitAnnotationJob(job.id);
        setJob(updated);
        setReviewStatus('submitted');
        if (imageId) {
          const submittedDraft = draftRef.current[imageId] ?? snapshot;
          draftRef.current[imageId] = { ...submittedDraft, reviewStatus: 'submitted', dirty: false };
        }
        try {
          const nextJob = await claimNextAnnotationJob(dataset.id);
          if (!nextJob) throw Object.assign(new Error('当前没有可领取的下一段任务'), { code: 'NO_AVAILABLE_ANNOTATION_JOB' });
          draftRef.current = {};
          draftCanvasSizesRef.current = {};
          currentDraftRef.current = { annotations: [], captions: [], imageAttributes: emptyAttributes, revision: 0, dirty: false, reviewStatus: 'draft' };
          draftVersionRef.current += 1;
          historyRef.current = []; futureRef.current = []; historyDraftsRef.current = []; futureDraftsRef.current = [];
          setAnnotations([]); setCaptions([]); setImageAttributes(emptyAttributes); setRevision(0); setReviewStatus('draft'); setReviewComment(undefined); setSelectedId(undefined); setHiddenIds([]); setLockedIds([]); setPinnedIds([]); setDraftPoints([]); setDraftCursor(undefined); setSetupTool(undefined); setDrawingTool(undefined); setPlaying(false); setSegments([]); setJob(nextJob); setSyncState('loading');
          setSearchParams(selectedLabelName ? { label: selectedLabelName } : {});
          movedToNextJob = true;
          notify('任务段已提交', '已自动领取下一段任务', 'success');
        } catch (error) {
          setJob(updated); setReviewStatus('submitted'); setSyncState('saved');
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (code === 'NO_AVAILABLE_ANNOTATION_JOB') {
            notify('暂无可标注任务', '当前任务段已提交，暂时没有可领取的下一段任务', 'info');
            navigate('/datasets', { replace: true });
          }
          else notify('任务段已提交', '自动领取下一段任务失败，请稍后从数据中心重试', 'error');
        }
      }
      if (!movedToNextJob) {
        setSyncState(changed || Object.values(draftRef.current).some((item) => item.dirty) ? 'dirty' : 'saved');
        if (announce) notify('标注已保存', '当前任务段的未保存标注已全部保存', 'success');
      }
      return true;
    } catch (error) { setSyncState('error'); notify('保存失败', error instanceof Error ? error.message : '无法保存当前标注', 'error'); return false; }
    finally {
      saveInFlightRef.current = false;
      const shouldRetry = saveQueuedRef.current || changed;
      const shouldSubmit = saveSubmitQueuedRef.current;
      const shouldAnnounce = saveNoticeQueuedRef.current;
      saveQueuedRef.current = false;
      saveSubmitQueuedRef.current = false;
      saveNoticeQueuedRef.current = false;
      if (shouldRetry) window.setTimeout(() => void saveAll(shouldSubmit, shouldAnnounce), 0);
    }
  }, [claimNextAnnotationJob, dataset?.id, editingLocked, imageId, isLastSegmentFrame, isReviewMode, job, navigate, notify, previewDimensions, reviewJob, saveAnnotationDocument, saveReviewedAnnotation, selectedLabelName, setSearchParams, submitAnnotationJob, workImages]);

  useEffect(() => {
    if (!dirty || editingLocked) return;
    const timer = window.setTimeout(() => void saveAll(), 1500);
    return () => window.clearTimeout(timer);
  }, [dirty, editingLocked, saveAll]);

  const undo = () => {
    const previous = historyRef.current.pop();
    const previousDrafts = historyDraftsRef.current.pop();
    if (!previous) return;
    futureRef.current.push(clone(annotations));
    futureDraftsRef.current.push(draftAnnotationsSnapshot());
    if (previousDrafts) restoreDraftAnnotations(previousDrafts);
    draftVersionRef.current += 1;
    setAnnotations(previous); setSyncState('dirty');
    if (imageId) draftRef.current[imageId] = { ...currentDraftRef.current, annotations: clone(previous), dirty: true };
  };
  const redo = () => {
    const next = futureRef.current.pop();
    const nextDrafts = futureDraftsRef.current.pop();
    if (!next) return;
    historyRef.current.push(clone(annotations));
    historyDraftsRef.current.push(draftAnnotationsSnapshot());
    if (nextDrafts) restoreDraftAnnotations(nextDrafts);
    draftVersionRef.current += 1;
    setAnnotations(next); setSyncState('dirty');
    if (imageId) draftRef.current[imageId] = { ...currentDraftRef.current, annotations: clone(next), dirty: true };
  };
  const deleteSelected = () => { if (!selectedId || editingLocked) return; markDirty(annotations.filter((item) => item.id !== selectedId)); setSelectedId(undefined); };
  const flagSelected = () => { if (!selectedId || editingLocked) return; const next = annotations.map((item) => item.id === selectedId ? { ...item, flagged: true } : item); markDirty(next); setPanel('issues'); notify('对象已标记为错', '可在 Issues 面板中查看并继续修正', 'info'); };
  const toggleHidden = (id: string) => setHiddenIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleLocked = (id: string) => setLockedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleOccluded = (id: string) => {
    if (editingLocked) return;
    commitChangedAnnotations(annotations.map((shape) => shape.id === id ? { ...shape, occluded: !shape.occluded } : shape));
  };
  const decideReview = async (decision: 'approve' | 'reject') => {
    if (!reviewJob || editingLocked || !dataset) return;
    const comment = reviewComment?.trim();
    if (decision === 'reject' && !comment) {
      setDialog('review');
      notify('驳回需要原因', '请填写审核意见后再驳回', 'info');
      return;
    }
    if (!await saveAll()) return;
    try {
      const updated = await reviewAnnotationJob(reviewJob.id, comment ? { decision, comment } : { decision });
      setReviewJob(updated);
      setReviewStatus(decision === 'approve' ? 'approved' : 'rejected');
      const nextJob = await claimNextAnnotationReviewJob(dataset.id);
      if (!nextJob) throw Object.assign(new Error('当前没有可领取的下一段审核任务'), { code: 'NO_REVIEW_JOB_AVAILABLE' });
      const nextSegment = segments.find((item) => item.id === nextJob.segmentId);
      const nextImage = nextSegment && images.find((item) => item.id === nextSegment.startItemId);
      if (!nextImage) throw new Error('下一段审核任务没有可用图像');
      draftRef.current = {};
      draftCanvasSizesRef.current = {};
      currentDraftRef.current = { annotations: [], captions: [], imageAttributes: emptyAttributes, revision: 0, dirty: false, reviewStatus: 'draft' };
      draftVersionRef.current += 1;
      historyRef.current = []; futureRef.current = []; historyDraftsRef.current = []; futureDraftsRef.current = [];
      setReviewJob(undefined); setAnnotations([]); setCaptions([]); setImageAttributes(emptyAttributes); setRevision(0); setReviewStatus('draft'); setReviewComment(undefined); setSelectedId(undefined); setHiddenIds([]); setLockedIds([]); setPinnedIds([]); setDraftPoints([]); setDraftCursor(undefined); setSetupTool(undefined); setDrawingTool(undefined); setPlaying(false); setSyncState('loading');
      notify(decision === 'approve' ? '审核已通过' : '已退回返工', '已自动领取下一段待审核任务', 'success');
      navigate(`/annotate/${dataset.id}/job/${encodeURIComponent(nextJob.id)}?image=${encodeURIComponent(nextImage.id)}&mode=review`);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'NO_REVIEW_JOB_AVAILABLE') {
        notify('暂无待审核任务', '当前数据集已没有可领取的待审核任务', 'info');
        navigate('/datasets', { replace: true });
      } else {
        notify('审核操作失败', error instanceof Error ? error.message : '无法完成审核操作', 'error');
      }
    }
  };
  const updateSelected = (change: Partial<CanvasShape>) => {
    if (!selectedId || editingLocked) return;
    commitChangedAnnotations(annotations.map((shape) => shape.id === selectedId ? { ...shape, ...change } : shape));
  };
  const changeObjectLabel = (id: string, labelName: string) => {
    if (editingLocked) return;
    const label = labels.find((item) => item.name === labelName);
    if (!label) return;
    commitChangedAnnotations(annotations.map((shape) => shape.id === id ? { ...shape, label: label.name, color: label.color } : shape));
  };

  const removeObject = (id: string) => {
    if (editingLocked || !annotations.some((item) => item.id === id)) return;
    markDirty(annotations.filter((item) => item.id !== id));
    if (selectedId === id) setSelectedId(undefined);
  };

  const moveObject = (id: string, direction: -1 | 1) => {
    if (editingLocked) return;
    const index = annotations.findIndex((item) => item.id === id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= annotations.length) return;
    const next = [...annotations];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    markDirty(next);
  };

  const createObjectUrl = (id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('object', id);
    setSelectedId(id);
    if (!navigator.clipboard) {
      notify('对象链接已生成', url.toString(), 'info');
      return;
    }
    void navigator.clipboard.writeText(url.toString()).then(() => notify('对象链接已复制', '打开链接后会定位到该对象', 'success')).catch(() => notify('对象链接已生成', url.toString(), 'info'));
  };

  const copyObject = (item: CanvasShape) => {
    clipboardRef.current = clone(item);
    setSelectedId(item.id);
    notify('对象已复制', '可使用 Ctrl+V 粘贴对象', 'success');
  };

  const updateImageTags = (tags: string[]) => {
    if (editingLocked || !imageId) return;
    const nextAttributes = { ...imageAttributes, tags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 100) };
    draftVersionRef.current += 1;
    setImageAttributes(nextAttributes);
    setSyncState('dirty');
    draftRef.current[imageId] = { ...currentDraftRef.current, imageAttributes: nextAttributes, dirty: true };
  };

  const addImageTag = () => {
    const value = tagInput.trim();
    if (!value || value.length > 80 || imageAttributes.tags.includes(value)) return;
    updateImageTags([...imageAttributes.tags, value]);
    setTagInput('');
  };

  const selectWorkspace = (nextWorkspace: 'standard' | 'attributes' | 'tags') => {
    setWorkspace(nextWorkspace);
    if (nextWorkspace === 'tags') setPanel('labels');
    if (nextWorkspace === 'attributes') setPanel('objects');
  };

  const toggleSelectedKeyframe = () => {
    if (!selected || editingLocked) return;
    if (!selected.trackId) {
      notify('当前对象不是追踪对象', '关键帧仅适用于追踪对象', 'info');
      return;
    }
    const next = annotations.map((shape) => shape.id === selected.id ? { ...shape, keyframe: !shape.keyframe, provenance: !shape.keyframe ? 'manual' as const : 'interpolated' as const } : shape);
    void loadAllDrafts().then(() => commitAnnotations(next, annotations, [selected.trackId!])).catch((error: unknown) => notify('关键帧更新失败', error instanceof Error ? error.message : '无法读取任务段图像', 'error'));
  };

  const copyObjectAcrossFrames = (source: CanvasShape) => {
    if (editingLocked) return;
    void loadAllDrafts().then(() => {
      workImages.forEach((image, frameIndex) => {
        if (frameIndex === currentIndex) return;
        const draft = draftRef.current[image.id];
        if (!draft) return;
        const copy = { ...clone(source), id: createId('copy'), trackId: undefined, keyframe: undefined, provenance: 'copied' as const };
        draftRef.current[image.id] = { ...draft, annotations: [...draft.annotations, copy], dirty: true };
      });
      if (imageId) draftRef.current[imageId] = { ...currentDraftRef.current, dirty: true };
      draftVersionRef.current += 1;
      setSyncState('dirty');
      notify('标注已复制到任务段', '已保留其他帧的现有对象', 'success');
    }).catch((error: unknown) => notify('跨帧复制失败', error instanceof Error ? error.message : '无法读取任务段图像', 'error'));
  };

  const copySelectedAcrossFrames = () => {
    if (!selected || editingLocked) return;
    copyObjectAcrossFrames(selected);
  };

  const jumpTrackKeyframe = (direction: 1 | -1) => {
    if (!selected?.trackId) {
      notify('未选择追踪对象', '请先选择一个带追踪标识的对象', 'info');
      return;
    }
    void loadAllDrafts().then(() => {
      const frames: TrackFrame[] = workImages.flatMap((image, frameIndex) => draftRef.current[image.id] ? [{ imageId: image.id, frameIndex, annotations: draftRef.current[image.id].annotations }] : []);
      const target = nextTrackKeyframe(frames, currentIndex, selected.trackId!, direction);
      if (target !== undefined) setImage(target);
    }).catch((error: unknown) => notify('关键帧读取失败', error instanceof Error ? error.message : '无法读取任务段图像', 'error'));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement; if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const key = event.key.toLowerCase(); const command = event.ctrlKey || event.metaKey;
      if (command && key === 's') { event.preventDefault(); void saveAll(false, true); return; }
      if (command && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (command && key === 'y') { event.preventDefault(); redo(); return; }
      if (command && key === 'r') { event.preventDefault(); setRotation((value) => (value + (event.shiftKey ? -90 : 90) + 360) % 360); return; }
      if (command && event.altKey && key === 'enter') { event.preventDefault(); setShowGrid((value) => !value); return; }
      if (command && key === 'c' && selected) { event.preventDefault(); clipboardRef.current = clone(selected); return; }
      if (command && key === 'v' && clipboardRef.current && !editingLocked) { event.preventDefault(); const copy = { ...clone(clipboardRef.current), id: `copy-${Date.now()}` }; markDirty([...annotations, copy]); setSelectedId(copy.id); return; }
      if (command && key === 'b' && selected) { event.preventDefault(); copySelectedAcrossFrames(); return; }
      if (key === 'f1') { event.preventDefault(); setDialog('shortcuts'); return; }
      if (key === 'f2') { event.preventDefault(); setDialog('settings'); return; }
      if (key === 'escape') { handlePointerCancel(); return; }
      if (key === 'delete' || (event.shiftKey && key === 'backspace')) { deleteSelected(); return; }
      if (key === 'q' || key === '/') { updateSelected({ occluded: !selected?.occluded }); return; }
      if (key === 'k') { toggleSelectedKeyframe(); return; }
      if (key === 'o') { updateSelected({ outside: !selected?.outside }); return; }
      if (key === 'l') { if (event.shiftKey) setLockedIds([]); else if (selected) toggleLocked(selected.id); return; }
      if (key === 'h') { if (event.shiftKey) setHiddenIds([]); else if (selected) toggleHidden(selected.id); return; }
      if (key === '-' || key === '_') { if (selected) updateSelected({ zOrder: (selected.zOrder ?? 0) - 1 }); return; }
      if (key === '+' || key === '=') { if (selected) updateSelected({ zOrder: (selected.zOrder ?? 0) + 1 }); return; }
      if (!command && key === 'r' && selected?.trackId) { event.preventDefault(); jumpTrackKeyframe(1); return; }
      if (!command && key === 'e' && selected?.trackId) { event.preventDefault(); jumpTrackKeyframe(-1); return; }
      if (key === 'f') { setImage(currentIndex + 1); return; }
      if (key === 'd') { setImage(currentIndex - 1); return; }
      if (!command && key === 'v') selectTool('cursor'); else if (!command && key === 'r') selectTool('rectangle'); else if (!command && key === 'p') selectTool('polygon'); else if (!command && key === 'n') selectTool('polyline'); else if (!command && key === 'b') selectTool('cuboid');
      if (key === 'enter' && draftPoints.length) { if (drawingTool === 'points') finishPoints(); else finishPath(); }
      if (key === 'space') { event.preventDefault(); setPlaying((value) => !value); }
      if (key === 'tab' && annotations.length) { event.preventDefault(); const index = selectedId ? annotations.findIndex((item) => item.id === selectedId) : -1; const next = annotations[(index + (event.shiftKey ? -1 : 1) + annotations.length) % annotations.length]; setSelectedId(next.id); }
    };
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!dataset) return <div className="reference-workbench-loading"><h1>请选择数据集图像</h1></div>;
  if (workbenchLoadState === 'empty') return <div className="reference-workbench-loading"><h1>{isReviewMode ? '暂无待审核任务' : '暂无可标注任务'}</h1><p>请返回数据中心选择其他任务。</p></div>;
  if (workbenchLoadState === 'error') return <div className="reference-workbench-loading"><h1>标注任务加载失败</h1><p>请返回数据中心后重试。</p></div>;
  if (!imageId || !currentImage) return <div className="reference-workbench-loading">正在加载标注任务…</div>;

  const handleShapePointerDown = (event: ReactPointerEvent<SVGElement>, shape: CanvasShape) => {
    if (editingLocked || tool !== 'cursor' || lockedIds.includes(shape.id) || shape.locked) return;
    event.stopPropagation();
    setSelectedId(shape.id);
    shapeDragRef.current = { pointerId: event.pointerId, id: shape.id, start: toPoint(event), original: clone(shape) };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleHandlePointerDown = (event: ReactPointerEvent<SVGCircleElement>, shape: CanvasShape, handle: number) => {
    if (editingLocked || tool !== 'cursor' || lockedIds.includes(shape.id) || shape.locked) return;
    event.stopPropagation();
    setSelectedId(shape.id);
    handleDragRef.current = { pointerId: event.pointerId, id: shape.id, handle, original: clone(shape) };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const renderHandles = (shape: CanvasShape) => {
    if (selectedId !== shape.id || tool !== 'cursor' || editingLocked || shape.locked) return null;
    const geometry = shape.geometry;
    const points = geometry.type === 'rectangle'
      ? [{ x: geometry.x, y: geometry.y }, { x: geometry.x + geometry.width / 2, y: geometry.y }, { x: geometry.x + geometry.width, y: geometry.y }, { x: geometry.x + geometry.width, y: geometry.y + geometry.height / 2 }, { x: geometry.x + geometry.width, y: geometry.y + geometry.height }, { x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height }, { x: geometry.x, y: geometry.y + geometry.height }, { x: geometry.x, y: geometry.y + geometry.height / 2 }]
      : geometry.type === 'keypoint' ? [{ x: geometry.x, y: geometry.y }]
        : 'points' in geometry ? geometry.points : [];
    return <g className="reference-handles">{points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={handleRadius} onPointerDown={(event) => handleHandlePointerDown(event, shape, index)} />)}</g>;
  };

  const renderShapeLabel = (shape: CanvasShape, x: number | undefined, y: number | undefined, color: string) => {
    if (!showLabels || x === undefined || y === undefined) return null;
    return <text className="reference-shape-label" x={x} y={Math.max(annotationLabelFontSize, y - annotationLabelGap)} style={{ fill: color, fontSize: `${annotationLabelFontSize}px` }}>{shapeLabel(shape)}</text>;
  };

  const renderShape = (shape: CanvasShape) => {
    if (hiddenIds.includes(shape.id)) return null;
    const active = selectedId === shape.id; const locked = lockedIds.includes(shape.id) || Boolean(shape.locked); const colorIndex = Math.abs([...shape.id].reduce((total, character) => total + character.charCodeAt(0), 0)) % colors.length; const displayColor = colorDimension === 'label' ? shape.color : colors[colorIndex]; const shapeStyle = { stroke: showOutlines ? displayColor : 'transparent', fill: displayColor, fillOpacity: 0.03 * (opacity / 100), strokeOpacity: opacity / 100 };
    const common = { 'data-shape-id': shape.id, className: `reference-shape ${active ? 'selected' : ''} ${locked ? 'locked' : ''}`, onPointerDown: (event: ReactPointerEvent<SVGElement>) => handleShapePointerDown(event, shape), onClick: (event: ReactMouseEvent<SVGElement>) => { if (drawingTool === tool) return; event.stopPropagation(); if (tool === 'cursor') setSelectedId(shape.id); } };
    const geometry = shape.geometry;
    if (geometry.type === 'rectangle') return <g key={shape.id} {...common}><rect x={geometry.x} y={geometry.y} width={geometry.width} height={geometry.height} style={shapeStyle} />{renderShapeLabel(shape, geometry.x, geometry.y, displayColor)}{renderHandles(shape)}</g>;
    if (geometry.type === 'polygon') return <g key={shape.id} {...common}><polygon points={geometry.points.map((point) => `${point.x},${point.y}`).join(' ')} style={shapeStyle} />{renderShapeLabel(shape, geometry.points[0]?.x, geometry.points[0]?.y, displayColor)}{renderHandles(shape)}</g>;
    if (geometry.type === 'polyline') return <g key={shape.id} {...common}><polyline points={geometry.points.map((point) => `${point.x},${point.y}`).join(' ')} style={{ ...shapeStyle, fill: 'none' }} />{renderShapeLabel(shape, geometry.points[0]?.x, geometry.points[0]?.y, displayColor)}{renderHandles(shape)}</g>;
    if (geometry.type === 'keypoint') return <g key={shape.id} {...common}><circle cx={geometry.x} cy={geometry.y} r={7 * canvasUnitScale} style={shapeStyle} /><circle cx={geometry.x} cy={geometry.y} r={2 * canvasUnitScale} style={{ fill: '#fff', opacity: opacity / 100 }} />{renderHandles(shape)}</g>;
    if (geometry.type === 'ellipse') return <g key={shape.id} {...common}><ellipse cx={geometry.cx} cy={geometry.cy} rx={geometry.rx} ry={geometry.ry} transform={`rotate(${geometry.rotation} ${geometry.cx} ${geometry.cy})`} style={shapeStyle} />{renderShapeLabel(shape, geometry.cx - geometry.rx, geometry.cy - geometry.ry, displayColor)}{renderHandles(shape)}</g>;
    if (geometry.type === 'skeleton') return <g key={shape.id} {...common}><polyline points={geometry.points.map((point) => `${point.x},${point.y}`).join(' ')} style={{ ...shapeStyle, fill: 'none' }} />{geometry.points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={4 * canvasUnitScale} style={shapeStyle} />)}{renderShapeLabel(shape, geometry.points[0]?.x, geometry.points[0]?.y, displayColor)}{renderHandles(shape)}</g>;
    if (geometry.type === 'cuboid') {
      const points = geometry.points.map((point) => `${point.x},${point.y}`).join(' ');
      const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      return <g key={shape.id} {...common}><polygon points={points} style={shapeStyle} />{edges.map(([from, to]) => <line key={`${from}-${to}`} x1={geometry.points[from].x} y1={geometry.points[from].y} x2={geometry.points[to].x} y2={geometry.points[to].y} style={{ stroke: displayColor, strokeOpacity: opacity / 100, strokeDasharray: showProjections ? '8 6' : undefined }} />)}{renderShapeLabel(shape, geometry.points[0]?.x, geometry.points[0]?.y, displayColor)}{renderHandles(shape)}</g>;
    }
    return null;
  };

  const livePointTool = tool === 'polygon' || tool === 'polyline' || (tool === 'rectangle' && rectangleMethod === 'four') || (tool === 'cuboid' && cuboidMethod === 'four');
  const draftPreviewPoints = livePointTool && draftCursor ? [...draftPoints, draftCursor] : draftPoints;
  const draftPreviewCoordinates = draftPreviewPoints.map((point) => `${point.x},${point.y}`).join(' ');
  const setupLabel = setupTool === 'rectangle' ? '矩形' : setupTool === 'polygon' ? '多边形' : setupTool === 'polyline' ? '折线' : setupTool === 'points' ? '点' : '立方体';
  const setupTitle = `绘制新${setupLabel}`;
  const setupHasMethods = setupTool === 'rectangle' || setupTool === 'cuboid';
  const setupHasPointCount = setupTool === 'polygon' || setupTool === 'polyline' || setupTool === 'points';
  const completeLabel = drawingTool === 'polygon' ? '完成多边形' : drawingTool === 'polyline' ? '完成折线' : '完成点';
  const drawingMinimum = drawingTool === 'polygon' ? 3 : drawingTool === 'polyline' ? 2 : 1;
  const flaggedAnnotations = annotations.filter((item) => item.flagged);

  return <div className="reference-workbench" data-testid="reference-workbench">
    <header className="reference-topbar"><Link className="reference-back-button" to="/datasets" aria-label="返回数据中心" title="返回数据中心"><ArrowLeft size={16} /><span>返回数据中心</span></Link>{isReviewer && <nav className="reference-nav"><Link to="/tasks"><Tag size={15} />任务</Link><Link to="/"><ShieldAlert size={15} />绩效</Link><Link to="/tasks"><Settings2 size={15} />任务段管理</Link></nav>}</header>
    <div className="reference-jobbar">
      <div className="reference-job-actions">{drawingTool && ['polygon', 'polyline', 'points'].includes(drawingTool) && draftPoints.length > 0 && <button onClick={() => drawingTool === 'points' ? finishPoints() : finishPath()} disabled={editingLocked || draftPoints.length < drawingMinimum} title={completeLabel} aria-label={completeLabel}><Check size={16} />完成</button>}<button onClick={() => void saveAll(false, true)} disabled={editingLocked || syncState === 'saving'} title="保存"><Save size={16} />保存</button><button onClick={undo} disabled={!historyRef.current.length} title="撤销"><Undo2 size={16} />撤销</button><button onClick={redo} disabled={!futureRef.current.length} title="重做"><Redo2 size={16} />重做</button>{isReviewMode ? <><button onClick={() => setDialog('review')} aria-label="审核意见" title="审核意见"><MessageSquare size={16} />意见</button><button onClick={() => void decideReview('approve')} disabled={!isReviewer || editingLocked}><Check size={16} />通过</button><button onClick={() => void decideReview('reject')} disabled={!isReviewer || editingLocked}><XCircle size={16} />驳回</button></> : <button onClick={() => void saveAll(true)} disabled={editingLocked || syncState === 'saving'}><Check size={16} />提交</button>}<button className="danger" onClick={flagSelected} disabled={!selectedId || editingLocked} title="标记为错" aria-label="标记为错"><XCircle size={16} />标记为错</button></div>
      <div className="reference-playback"><button onClick={() => setImage(0)} disabled={currentIndex <= 0} aria-label="第一帧" title="第一帧"><ChevronsLeft size={16} /></button><button onClick={() => setImage(currentIndex - 1)} disabled={currentIndex <= 0} aria-label="上一张" title="上一张"><ChevronLeft size={16} /></button><button onClick={() => jumpTrackKeyframe(-1)} aria-label="上一关键帧" title="上一关键帧"><SkipBack size={16} /></button><button onClick={() => setPlaying((value) => !value)} aria-label="播放/暂停" title="播放/暂停">{playing ? <Pause size={16} /> : <Play size={16} />}</button><button onClick={() => jumpTrackKeyframe(1)} aria-label="下一关键帧" title="下一关键帧"><SkipForward size={16} /></button><button onClick={() => setImage(currentIndex + 1)} disabled={currentIndex >= workImages.length - 1} aria-label="下一张" title="下一张"><ChevronRight size={16} /></button><button onClick={() => setImage(workImages.length - 1)} disabled={currentIndex >= workImages.length - 1} aria-label="最后一帧" title="最后一帧"><ChevronsRight size={16} /></button><div className="reference-playback-track"><div className="reference-range-column"><input aria-label="帧进度" type="range" min="0" max={Math.max(0, workImages.length - 1)} value={Math.max(0, currentIndex)} onChange={(event) => setImage(Number(event.target.value))} /><strong className="filename">{currentImage.filename}</strong></div><label>帧 <input className="frame-input" value={currentIndex} onChange={(event) => setImage(Number(event.target.value))} /></label><span>/ {Math.max(0, workImages.length - 1)}</span></div></div>
      <div className="reference-frame-tools"><button onClick={() => setDialog('shortcuts')} aria-label="快捷键" title="快捷键">快捷键</button><button onClick={() => setDialog('settings')} aria-label="设置" title="设置">设置</button><button onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())} aria-label="全屏" title="全屏"><Maximize2 size={16} /></button><button className="reference-info-button" onClick={() => setDialog('info')} aria-label="标注信息" title="标注信息"><ShieldAlert size={16} />标注信息</button><button className="reference-mobile-panel-button" onClick={() => setObjectsOpen((value) => !value)} aria-label="对象面板">对象</button><select className="reference-workspace-selector" aria-label="工作区" title="工作区" value={workspace} onChange={(event) => selectWorkspace(event.target.value as 'standard' | 'attributes' | 'tags')}><option value="standard">标准</option><option value="attributes">属性标注</option><option value="tags">标记标注</option></select></div>
    </div>
    <div className="reference-editor"><aside className="reference-tool-rail"><button onClick={() => selectTool('cursor')} className={tool === 'cursor' ? 'active' : ''} aria-label="光标" title="光标 (V)"><MousePointer2 size={21} /></button><button onClick={() => selectTool('move')} className={tool === 'move' ? 'active' : ''} disabled={editingLocked} aria-label="移动画布" title="移动画布 (M)"><Move size={21} /></button><button onClick={() => setRotation((value) => (value + 90) % 360)} aria-label="顺时针旋转" title="顺时针旋转"><RotateCw size={21} /></button><button onClick={() => { setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); }} aria-label="适应画布" title="适应画布"><Maximize2 size={21} /></button>{tools.filter(({ id }) => !['cursor', 'move'].includes(id)).map(({ id, label, shortcut, icon: Icon }) => <button key={id} className={tool === id ? 'active' : ''} onClick={() => selectTool(id)} disabled={editingLocked} title={`${label} (${shortcut})`} aria-label={label}><Icon size={21} /></button>)}<button onClick={() => setPanel('labels')} aria-label="标签工具" title="标签工具"><Tag size={21} /></button><span /></aside>
      {setupTool && <section className="reference-polygon-popover" role="dialog" aria-label={setupTitle}><div className="reference-polygon-popover-header"><strong>{setupTitle}</strong><button onClick={() => selectTool('cursor')} aria-label="关闭绘制配置" title="关闭"><XCircle size={15} /></button></div><label>标签<select aria-label={`${setupLabel}标签`} value={activeLabel?.name ?? ''} onChange={(event) => setSearchParams({ image: imageId, ...(isReviewMode ? { mode: 'review' } : {}), label: event.target.value })}>{labels.map((label) => <option key={label.name} value={label.name}>{label.name}</option>)}</select></label>{setupHasMethods && <fieldset className="reference-draw-method"><legend>绘制方法</legend>{setupTool === 'rectangle' ? <><label><input type="radio" name="rectangle-method" checked={rectangleMethod === 'two'} onChange={() => setRectangleMethod('two')} />两点</label><label><input type="radio" name="rectangle-method" checked={rectangleMethod === 'four'} onChange={() => setRectangleMethod('four')} />四点</label></> : <><label><input type="radio" name="cuboid-method" checked={cuboidMethod === 'rectangle'} onChange={() => setCuboidMethod('rectangle')} />矩形</label><label><input type="radio" name="cuboid-method" checked={cuboidMethod === 'four'} onChange={() => setCuboidMethod('four')} />四点</label></>}</fieldset>}{setupHasPointCount && <label>点数<input aria-label={`${setupLabel}点数`} type="number" min={setupTool === 'points' ? 1 : setupTool === 'polyline' ? 2 : 3} step="1" inputMode="numeric" placeholder="可选" value={pointCount} onChange={(event) => setPointCount(event.target.value)} /></label>}<div className="reference-polygon-popover-actions"><button className="primary" onClick={() => void startDrawing(setupTool, 'shape')} disabled={editingLocked || trackLoading} title={`开始绘制${setupLabel}`} aria-label={`开始绘制${setupLabel}`}><Pencil size={14} />绘制</button><button onClick={() => void startDrawing(setupTool, 'track')} disabled={editingLocked || trackLoading} title={`开始追踪${setupLabel}`} aria-label={`开始追踪${setupLabel}`}><SkipForward size={14} />追踪</button></div></section>}
      <main className={`reference-canvas-area ${showGrid ? 'grid' : ''}`} data-tool={tool} aria-busy={!frameReady} onWheel={(event) => { const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1; setZoom((value) => Math.max(0.1, Math.min(10, value * factor))); }}><div className="reference-canvas" style={{ aspectRatio: `${canvasSize.width} / ${canvasSize.height}`, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)` }}><img key={imageId} src={preview?.imageId === imageId ? preview.url : undefined} alt="当前标注图像" draggable={false} style={{ opacity: previewReadyId === imageId ? 1 : 0, pointerEvents: previewReadyId === imageId ? 'auto' : 'none' }} onLoad={(event) => { const { naturalWidth, naturalHeight } = event.currentTarget; setPreviewReadyId(imageId); if (naturalWidth > 0 && naturalHeight > 0) setPreviewDimensions((current) => current[imageId]?.width === naturalWidth && current[imageId]?.height === naturalHeight ? current : { ...current, [imageId]: { width: naturalWidth, height: naturalHeight } }); }} /><svg ref={svgRef} viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} preserveAspectRatio="none" style={{ visibility: frameReady ? 'visible' : 'hidden' }} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerCancel} onClick={handleCanvasClick} onContextMenu={(event) => { event.preventDefault(); handlePointerCancel(); }}><g>{annotations.map(renderShape)}</g>{draftPoints.length > 0 && <g className="reference-point-draft">{tool === 'polygon' && draftPreviewPoints.length >= 3 && <polygon className="reference-polygon-draft" points={draftPreviewCoordinates} />}{tool === 'rectangle' && rectangleMethod === 'four' && draftPreviewPoints.length >= 3 && <polygon className="reference-polygon-draft" points={draftPreviewCoordinates} />}{(tool === 'polygon' || tool === 'polyline' || (tool === 'cuboid' && cuboidMethod === 'four')) && <polyline className="reference-polygon-guide" points={draftPreviewCoordinates} />}{tool === 'rectangle' && rectangleMethod === 'two' && draftPoints.length === 1 && <rect className="reference-draft" {...rectangle(draftPoints[0], draftCursor ?? draftPoints[0])} />}{tool === 'cuboid' && cuboidMethod === 'rectangle' && draftPoints.length === 1 && <rect className="reference-draft" {...rectangle(draftPoints[0], draftCursor ?? draftPoints[0])} />}{tool === 'points' && draftPoints.map((point, index) => <circle className="reference-point-vertex" key={index} cx={point.x} cy={point.y} r={handleRadius} />)}{livePointTool && draftPoints.map((point, index) => <circle className="reference-polygon-vertex" key={`vertex-${index}`} cx={point.x} cy={point.y} r={handleRadius} />)}{livePointTool && draftCursor && <circle className="reference-polygon-cursor" cx={draftCursor.x} cy={draftCursor.y} r={handleRadius} />}</g>}</svg></div></main>
      <aside className={`reference-objects ${objectsOpen ? 'mobile-open' : ''}`}>
        <div className="reference-panel-tabs"><button className={panel === 'objects' ? 'active' : ''} aria-label={`对象 ${annotations.length}`} onClick={() => setPanel('objects')}>对象</button><button className={panel === 'labels' ? 'active' : ''} onClick={() => setPanel('labels')}>标签</button><button className={panel === 'issues' ? 'active' : ''} aria-label={`Issues ${flaggedAnnotations.length}`} onClick={() => setPanel('issues')}>Issues</button></div>
        {panel === 'objects' && <><div className="reference-object-toolbar"><button onClick={() => setLockedIds([])} aria-label="解锁全部对象" title="解锁全部对象"><Unlock size={14} /></button><button onClick={() => setHiddenIds([])} aria-label="显示全部对象" title="显示全部对象"><Eye size={14} /></button><ChevronUp size={14} aria-hidden="true" /><span>排序</span><select aria-label="对象排序" defaultValue="id-asc"><option value="id-asc">ID升序</option></select></div><div className="reference-object-list">{annotations.map((item, index) => {
          const locked = lockedIds.includes(item.id) || item.locked;
          const hidden = hiddenIds.includes(item.id);
          const occluded = Boolean(item.occluded);
          const pinned = pinnedIds.includes(item.id);
          return <div key={item.id} className={`reference-object ${selectedId === item.id ? 'selected' : ''}`} style={{ '--object-color': item.color } as CSSProperties} onClick={() => setSelectedId(item.id)}>
            <i style={{ background: item.color }} />
            <div className="reference-object-heading"><span>{index + 1}</span><small>{geometryLabel(item)}{item.trackId ? ' · 追踪' : ''}{item.provenance === 'interpolated' ? ' · 插值' : ''}</small></div>
            <select aria-label={`对象 ${index + 1} 标签`} value={shapeLabel(item)} onClick={(event) => event.stopPropagation()} onChange={(event) => { event.stopPropagation(); changeObjectLabel(item.id, event.target.value); }}>{labels.map((label) => <option key={label.name} value={label.name}>{label.name}</option>)}</select>
            <details className="reference-object-menu" onClick={(event) => event.stopPropagation()}>
              <summary className="reference-object-more" aria-label="更多对象操作" title="更多对象操作"><MoreHorizontal size={14} /></summary>
              <div role="menu"><button type="button" role="menuitem" onClick={() => createObjectUrl(item.id)}><Link2 size={14} />创建对象URL</button><button type="button" role="menuitem" onClick={() => copyObject(item)}><Copy size={14} />复制</button><button type="button" role="menuitem" onClick={() => copyObjectAcrossFrames(item)}><SkipForward size={14} />跨帧复制</button><button type="button" role="menuitem" onClick={() => moveObject(item.id, 1)}><Layers size={14} />到下一层</button><button type="button" role="menuitem" onClick={() => moveObject(item.id, -1)}><Layers size={14} />到上一层</button><button type="button" role="menuitem" onClick={() => removeObject(item.id)}><Trash2 size={14} />移除</button></div>
            </details>
            <div className="reference-object-actions"><button onClick={(event) => { event.stopPropagation(); toggleLocked(item.id); }} aria-label={locked ? '解锁对象' : '锁定对象'} title={locked ? '解锁对象' : '锁定对象'} aria-pressed={locked}>{locked ? <Lock size={14} /> : <Unlock size={14} />}</button><button onClick={(event) => { event.stopPropagation(); toggleOccluded(item.id); }} aria-label={occluded ? '取消遮挡' : '标记遮挡'} title={occluded ? '取消遮挡' : '标记遮挡'} aria-pressed={occluded}><UserRound size={14} /></button><button onClick={(event) => { event.stopPropagation(); toggleHidden(item.id); }} aria-label={hidden ? '显示对象' : '隐藏对象'} title={hidden ? '显示对象' : '隐藏对象'} aria-pressed={hidden}>{hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button><button className={pinned ? 'active' : ''} onClick={(event) => { event.stopPropagation(); setPinnedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]); }} aria-label={pinned ? '取消置顶对象' : '置顶对象'} title={pinned ? '取消置顶对象' : '置顶对象'} aria-pressed={pinned}><Pin size={14} /></button></div>
          </div>;
        })}</div></>}
        {panel === 'labels' && <div className="reference-label-list"><label className="reference-tag-editor">图像标签<input aria-label="图像标签" value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addImageTag(); } }} placeholder="输入后按 Enter 添加" /><span>{imageAttributes.tags.map((tag) => <button key={tag} type="button" onClick={() => updateImageTags(imageAttributes.tags.filter((item) => item !== tag))} aria-label={`移除标签 ${tag}`}>{tag}<XCircle size={12} /></button>)}</span></label><div className="reference-label-divider">对象标签</div>{labels.map((label) => <button key={label.name} className={activeLabel?.name === label.name ? 'active' : ''} onClick={() => setSearchParams({ image: imageId, ...(isReviewMode ? { mode: 'review' } : {}), label: label.name })}><i style={{ background: label.color }} />{label.name}</button>)}</div>}
        {panel === 'issues' && <div className="reference-empty-panel">{flaggedAnnotations.length ? flaggedAnnotations.map((item) => <button key={item.id} className="reference-issue" onClick={() => { setSelectedId(item.id); setPanel('objects'); }}>{geometryLabel(item)} · {shapeLabel(item)}{item.trackId ? ' · 追踪对象' : ''}</button>) : '当前帧暂无 Issues'}</div>}
        <section className="reference-appearance"><strong>外观设置</strong><span>颜色维度</span><div>{(['label', 'instance', 'group'] as const).map((dimension) => <button key={dimension} className={colorDimension === dimension ? 'active' : ''} onClick={() => setColorDimension(dimension)}>{dimension === 'label' ? '标签' : dimension === 'instance' ? '实例' : '群组'}</button>)}</div><label>透明度<input type="range" min="0" max="100" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /></label><label><input type="checkbox" checked={showOutlines} onChange={(event) => setShowOutlines(event.target.checked)} />外轮廓边框</label><label><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} />显示标签</label><label><input type="checkbox" checked={showProjections} onChange={(event) => setShowProjections(event.target.checked)} />显示投影</label></section>
      </aside>
    </div>
    {dialog === 'shortcuts' && <Modal title="快捷键" description="参考平台快捷键" onClose={() => setDialog(null)} footer={<button onClick={() => setDialog(null)}>关闭</button>}><div className="reference-shortcuts">{[['ctrl+alt+enter', '切换网格模式'], ['f1', '显示快捷键列表弹窗'], ['f2', '显示设置'], ['esc', '取消'], ['ctrl+r', '顺时针旋转'], ['ctrl+shift+r', '逆时针旋转'], ['ctrl+b', '复制当前对象到任务段'], ['ctrl+v', '粘贴'], ['r / e', '前后关键帧'], ['k', '切换关键帧'], ['Ctrl+S', '保存'], ['Ctrl+Z', '撤销'], ['Ctrl+Shift+Z / Ctrl+Y', '重做'], ['F / D', '前后帧'], ['Tab / Shift+Tab', '切换对象']].map(([key, name]) => <span key={key}><kbd>{key}</kbd>{name}</span>)}</div></Modal>}
    {dialog === 'settings' && <Modal title="设置" description="参考平台工作台设置" onClose={() => setDialog(null)} footer={<button onClick={() => setDialog(null)}>关闭</button>}><div className="reference-settings-controls"><label>透明度<input type="range" min="0" max="100" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /></label><label><input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />显示网格</label><label><input type="checkbox" checked={showOutlines} onChange={(event) => setShowOutlines(event.target.checked)} />显示外轮廓</label><label><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} />显示对象标签</label><label><input type="checkbox" checked={showProjections} onChange={(event) => setShowProjections(event.target.checked)} />显示投影</label><dl className="reference-info"><div><dt>画布缩放</dt><dd>{Math.round(zoom * 100)}%</dd></div><div><dt>画布旋转</dt><dd>{rotation}°</dd></div><div><dt>自动保存</dt><dd>开启</dd></div><div><dt>当前 Job</dt><dd>{currentJob?.id ?? '—'}</dd></div></dl></div></Modal>}
    {dialog === 'review' && <Modal title="审核意见" description="驳回任务段时必须填写原因" onClose={() => setDialog(null)} footer={<button onClick={() => setDialog(null)}>完成</button>}><label className="reference-review-comment"><textarea aria-label="审核意见" rows={5} value={reviewComment ?? ''} onChange={(event) => setReviewComment(event.target.value)} placeholder="请输入驳回原因" /></label></Modal>}
    {dialog === 'info' && <Modal title="标注信息" description="当前帧标注信息" onClose={() => setDialog(null)} footer={<button onClick={() => setDialog(null)}>关闭</button>}><dl className="reference-info"><div><dt>图像</dt><dd>{currentImage.filename}</dd></div><div><dt>对象数量</dt><dd>{annotations.length}</dd></div><div><dt>版本</dt><dd>{revision}</dd></div><div><dt>审核状态</dt><dd>{reviewStatus}</dd></div></dl></Modal>}
  </div>;
}
