import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataCenterPlaceholderPage } from './DataCenterPlaceholderPage';

describe('DataCenterPlaceholderPage', () => {
  it('keeps the administrator data center content area empty for the future data tree', () => {
    render(<DataCenterPlaceholderPage />);

    expect(screen.getByRole('heading', { name: '数据中心' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '数据中心内容区域' })).toBeEmptyDOMElement();
  });
});
