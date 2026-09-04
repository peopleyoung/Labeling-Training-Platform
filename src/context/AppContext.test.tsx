import { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  annotations: vi.fn(),
  capabilities: vi.fn(),
  saveAnnotations: vi.fn(),
  submitAnnotationJob: vi.fn(),
  datasets: vi.fn(),
}));

vi.mock('../services/apiClient', () => ({
  apiEnabled: true,
  ApiClientError: class ApiClientError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  ApiClient: class ApiClient {
    annotations = apiMocks.annotations;
    capabilities = apiMocks.capabilities;
    saveAnnotations = apiMocks.saveAnnotations;
    submitAnnotationJob = apiMocks.submitAnnotationJob;
    datasets = apiMocks.datasets;
  },
}));

import { AppProvider, useApp } from './AppContext';

function AnnotationLoader() {
  const { loadAnnotationDocument } = useApp();

  useEffect(() => {
    void loadAnnotationDocument('dataset-1', 'image-1');
  }, [loadAnnotationDocument]);

  return null;
}

function AnnotationSaver({ onSaved, onError }: { onSaved: (value: unknown) => void; onError: (error: unknown) => void }) {
  const { saveAnnotationDocument } = useApp();

  useEffect(() => {
    void saveAnnotationDocument({ datasetId: 'dataset-1', imageId: 'image-1', revision: 0, annotations: [] }).then(onSaved, onError);
  }, [onError, onSaved, saveAnnotationDocument]);

  return null;
}

function AnnotationSubmitter({ onSubmitted, onError }: { onSubmitted: (value: unknown) => void; onError: (error: unknown) => void }) {
  const { submitAnnotationJob } = useApp();

  useEffect(() => {
    void submitAnnotationJob('job-1').then(onSubmitted, onError);
  }, [onError, onSubmitted, submitAnnotationJob]);

  return null;
}

describe('AppContext annotation commands', () => {
  beforeEach(() => {
    apiMocks.annotations.mockReset().mockResolvedValue({
      datasetId: 'dataset-1',
      imageId: 'image-1',
      revision: 0,
      annotations: [],
      updatedAt: '2026-07-27T00:00:00.000Z',
      updatedBy: '',
    });
    apiMocks.capabilities.mockReset().mockResolvedValue({
      gpuEnabled: false,
      cpuTrainingEnabled: true,
      cpuOnnxEnabled: true,
      cpuConversionFormats: ['ONNX', 'TorchScript', 'OpenVINO'],
    });
    apiMocks.saveAnnotations.mockReset().mockResolvedValue({
      datasetId: 'dataset-1',
      imageId: 'image-1',
      revision: 1,
      annotations: [],
      captions: [],
      imageAttributes: { includeInSdxl: false, tags: [] },
      updatedAt: '2026-07-27T00:00:00.000Z',
      updatedBy: 'tester',
      reviewStatus: 'draft',
    });
    apiMocks.submitAnnotationJob.mockReset().mockResolvedValue({ id: 'job-1', status: 'submitted' });
    apiMocks.datasets.mockReset().mockRejectedValue(new Error('数据集列表暂时不可用'));
  });

  it('keeps the load command stable after caching a loaded document', async () => {
    render(<AppProvider><AnnotationLoader /></AppProvider>);

    await waitFor(() => expect(apiMocks.annotations).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    expect(apiMocks.annotations).toHaveBeenCalledTimes(1);
  });

  it('keeps annotation saves successful when the background dataset refresh fails', async () => {
    const onSaved = vi.fn();
    const onError = vi.fn();
    render(<AppProvider><AnnotationSaver onSaved={onSaved} onError={onError} /></AppProvider>);

    await waitFor(() => expect(apiMocks.saveAnnotations).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
    expect(apiMocks.datasets).toHaveBeenCalledTimes(1);
  });

  it('refreshes datasets after submitting an annotation job', async () => {
    const onSubmitted = vi.fn();
    const onError = vi.fn();
    apiMocks.datasets.mockResolvedValue({ items: [{ id: 'dataset-1', images: 2, annotated: 2 }] });
    render(<AppProvider><AnnotationSubmitter onSubmitted={onSubmitted} onError={onError} /></AppProvider>);

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith({ id: 'job-1', status: 'submitted' }));
    expect(onError).not.toHaveBeenCalled();
    expect(apiMocks.submitAnnotationJob).toHaveBeenCalledWith('job-1');
    expect(apiMocks.datasets).toHaveBeenCalledTimes(1);
  });
});
