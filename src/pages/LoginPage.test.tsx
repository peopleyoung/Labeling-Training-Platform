import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    apiEnabled: true,
    login: vi.fn(),
    session: { token: 'test-token' },
  }),
}));

function AnnotationDestination() {
  const location = useLocation();
  return <p>{`${location.pathname}${location.search}`}</p>;
}

describe('LoginPage', () => {
  it('preserves the protected annotation path and image query after login', () => {
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/login',
        state: { from: { pathname: '/annotate/dataset-1', search: '?image=image-1' } },
      }]}
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/annotate/:datasetId" element={<AnnotationDestination />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('/annotate/dataset-1?image=image-1')).toBeInTheDocument();
  });
});
