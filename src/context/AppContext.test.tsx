import { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  annotations: vi.fn(),
  capabilities: vi.fn(),
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
  });

  it('keeps the load command stable after caching a loaded document', async () => {
    render(<AppProvider><AnnotationLoader /></AppProvider>);

    await waitFor(() => expect(apiMocks.annotations).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    expect(apiMocks.annotations).toHaveBeenCalledTimes(1);
  });
});
